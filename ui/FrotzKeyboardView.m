//
//  FrotzKeyboardView.m
//  Frotz
//

#import "FrotzKeyboardView.h"

static const CGFloat kMinKeyHeight = 36, kMaxKeyHeight = 64, kMaxFillKeyHeight = 96;
static const NSTimeInterval kRepeatDelay = 0.4, kRepeatInterval = 0.08;
static const NSTimeInterval kShiftDoubleTapInterval = 0.35;
static const CGFloat kReleaseSlop = 16; // a finger rolls a little between down and up; only a real slide-off cancels

#pragma mark - Key view

// One key. Touches are handled by the keyboard, so a key never takes them itself.
@interface FrotzKeyView : UIView
@property (nonatomic, strong) FrotzKeyboardKey *key;
@property (nonatomic) BOOL pressed;
@property (nonatomic) BOOL latched; // shift held on for the next key or caps lock
@end

@implementation FrotzKeyView {
    FrotzKeyboardSkin *m_skin;
    UILabel *m_label, *m_sublabel;
    CAShapeLayer *m_bevel;
    CALayer *m_bottomEdge;
}

-(instancetype)initWithKey:(FrotzKeyboardKey *)key skin:(FrotzKeyboardSkin *)skin {
    if ((self = [super initWithFrame: CGRectZero])) {
        _key = key;
        m_skin = skin;
        self.userInteractionEnabled = NO;
        self.isAccessibilityElement = NO; // the keyboard provides the accessibility elements
        m_label = [[UILabel alloc] init];
        m_label.text = skin.upperCaseLegends ? [key.label uppercaseString] : key.label;
        m_label.textAlignment = NSTextAlignmentCenter;
        m_label.adjustsFontSizeToFitWidth = YES;
        m_label.minimumScaleFactor = 0.5;
        [self addSubview: m_label];
        if (key.sublabel) {
            m_sublabel = [[UILabel alloc] init];
            m_sublabel.text = key.sublabel;
            m_sublabel.textAlignment = NSTextAlignmentCenter;
            m_sublabel.adjustsFontSizeToFitWidth = YES;
            m_sublabel.minimumScaleFactor = 0.5;
            [self addSubview: m_sublabel];
        }
        self.layer.cornerRadius = skin.cornerRadius;
        if (skin.shadow) {
            self.layer.shadowColor = [UIColor blackColor].CGColor;
            self.layer.shadowOpacity = 0.3;
            self.layer.shadowOffset = CGSizeMake(0, 1);
            self.layer.shadowRadius = 0;
        }
        if (skin.profile == FrotzKeyProfileSculpted) {
            self.clipsToBounds = YES;
            m_bottomEdge = [CALayer layer];
            m_bottomEdge.backgroundColor = [UIColor colorWithWhite: 0 alpha: 0.3].CGColor;
            [self.layer addSublayer: m_bottomEdge];
            m_bevel = [CAShapeLayer layer];
            m_bevel.fillColor = nil;
            m_bevel.strokeColor = [UIColor colorWithWhite: 1 alpha: 0.45].CGColor;
            m_bevel.lineWidth = 1.5;
            [self.layer addSublayer: m_bevel];
        }
        [self updateColors];
    }
    return self;
}

-(void)updateColors {
    NSString *group = _key.group;
    self.backgroundColor = (_pressed || _latched) ? [m_skin pressedColorForGroup: group] : [m_skin keyColorForGroup: group];
    m_label.textColor = [m_skin textColorForGroup: group];
    m_sublabel.textColor = m_label.textColor;
}

-(void)setPressed:(BOOL)pressed {
    if (pressed == _pressed)
        return;
    _pressed = pressed;
    if (pressed || UIAccessibilityIsReduceMotionEnabled())
        [UIView performWithoutAnimation: ^{ [self updateColors]; }];
    else
        [UIView animateWithDuration: 0.12 animations: ^{ [self updateColors]; }];
}

-(void)setLatched:(BOOL)latched {
    _latched = latched;
    [self updateColors];
}

-(void)setFont:(UIFont *)font {
    // Word legends ("return", "space") sit smaller than single characters, as on iOS.
    m_label.font = _key.label.length > 2 ? [font fontWithSize: round(font.pointSize * 0.65)] : font;
    m_sublabel.font = [font fontWithSize: round(font.pointSize * 0.45)];
}

-(void)layoutSubviews {
    [super layoutSubviews];
    CGRect b = self.bounds;
    if (m_sublabel) {
        CGFloat subHeight = ceil(m_sublabel.font.lineHeight);
        m_sublabel.frame = CGRectMake(2, 2, b.size.width - 4, subHeight);
        m_label.frame = CGRectMake(2, subHeight, b.size.width - 4, b.size.height - subHeight - 2);
    } else
        m_label.frame = CGRectInset(b, 2, 0);
    if (self.layer.shadowOpacity > 0)
        self.layer.shadowPath = [UIBezierPath bezierPathWithRoundedRect: b cornerRadius: self.layer.cornerRadius].CGPath;
    if (m_bevel) {
        CGFloat edge = MAX(2, round(b.size.height * 0.08));
        m_bottomEdge.frame = CGRectMake(0, b.size.height - edge, b.size.width, edge);
        UIBezierPath *path = [UIBezierPath bezierPath];
        CGFloat inset = m_bevel.lineWidth / 2;
        [path moveToPoint: CGPointMake(inset, b.size.height - edge)];
        [path addLineToPoint: CGPointMake(inset, inset)];
        [path addLineToPoint: CGPointMake(b.size.width - inset, inset)];
        m_bevel.path = path.CGPath;
        m_bevel.frame = b;
    }
}

@end

#pragma mark - Accessibility

@interface FrotzKeyAccessibilityElement : UIAccessibilityElement
@property (nonatomic, weak) FrotzKeyView *keyView;
@end

@interface FrotzKeyboardView ()
-(void)keyTouchDown:(FrotzKeyView *)keyView touch:(nullable UITouch *)touch;
-(void)keyTouchUp:(FrotzKeyView *)keyView touch:(nullable UITouch *)touch inside:(BOOL)inside;
@end

@implementation FrotzKeyAccessibilityElement

-(BOOL)accessibilityActivate {
    FrotzKeyboardView *keyboard = (FrotzKeyboardView *)self.accessibilityContainer;
    FrotzKeyView *keyView = self.keyView;
    if (!keyView)
        return NO;
    [keyboard keyTouchDown: keyView touch: nil];
    [keyboard keyTouchUp: keyView touch: nil inside: YES];
    return YES;
}

@end

#pragma mark - Keyboard

@implementation FrotzKeyboardView {
    NSMutableArray<FrotzKeyView *> *m_keyViews;
    NSMapTable<UITouch *, FrotzKeyView *> *m_touchKeys;
    NSTimer *m_repeatTimer;
    FrotzKeyView *m_repeatKey;
    UITouch *m_repeatTouch;    // the touch that owns the repeat; nil for accessibility and DEBUG taps
    BOOL m_keysRebuilt;        // tell VoiceOver once the new elements are in place
    NSTimeInterval m_lastShiftTap;
    UIImpactFeedbackGenerator *m_feedback;
}

-(instancetype)initWithLayout:(FrotzKeyboardLayout *)layout skin:(FrotzKeyboardSkin *)skin {
    if ((self = [super initWithFrame: CGRectZero])) {
        _layout = layout;
        _skin = skin;
        _keyLayer = [FrotzKeyboardLayerDefault copy];
        self.backgroundColor = skin.caseColor;
        self.multipleTouchEnabled = YES;
        m_keyViews = [NSMutableArray array];
        m_touchKeys = [NSMapTable strongToStrongObjectsMapTable];
        m_feedback = [[UIImpactFeedbackGenerator alloc] initWithStyle: UIImpactFeedbackStyleLight];
        [self rebuildKeys];
    }
    return self;
}

-(void)dealloc {
    [m_repeatTimer invalidate];
}

// One unit of key width in a view this wide, after the side safe areas, bezel and gaps.
// Never below a point, so a view too narrow for its gaps squashes keys rather than flips them.
-(CGFloat)unitWidthForWidth:(CGFloat)width {
    UIEdgeInsets safe = self.safeAreaInsets, bezel = _skin.bezelInsets;
    CGFloat units = MAX(1, _layout.unitsPerRow), gap = _layout.gap;
    return MAX(1, (width - safe.left - safe.right - bezel.left - bezel.right - (units - 1) * gap) / units);
}

-(CGFloat)preferredHeightForWidth:(CGFloat)width {
    UIEdgeInsets bezel = _skin.bezelInsets;
    CGFloat gap = _layout.gap;
    NSUInteger rows = _layout.maxRowCount;
    CGFloat keyHeight = [self unitWidthForWidth: width] / _layout.keyAspect;
    keyHeight = MIN(kMaxKeyHeight, MAX(kMinKeyHeight, keyHeight));
    return ceil(bezel.top + bezel.bottom + rows * keyHeight + (rows > 0 ? rows - 1 : 0) * gap);
}

-(void)setTopInset:(CGFloat)topInset {
    _topInset = topInset;
    [self setNeedsLayout];
}

-(void)setFillsHeight:(BOOL)fillsHeight {
    _fillsHeight = fillsHeight;
    [self setNeedsLayout];
}

#pragma mark Layers and shift

-(void)setKeyLayer:(NSString *)layer {
    if ([layer isEqualToString: _keyLayer] || !_layout.layers[layer])
        return;
    _keyLayer = [layer copy];
    [self rebuildKeys];
}

-(void)setShiftState:(FrotzKeyboardShiftState)shiftState {
    _shiftState = shiftState;
    if (![_keyLayer isEqualToString: FrotzKeyboardLayerSymbols])
        self.keyLayer = shiftState == FrotzKeyboardShiftOff ? FrotzKeyboardLayerDefault : FrotzKeyboardLayerShift;
    [self updateLatchedKeys];
}

-(void)updateLatchedKeys {
    for (FrotzKeyView *kv in m_keyViews) {
        FrotzKeyAction action = kv.key.action;
        if (action == FrotzKeyActionShift)
            kv.latched = _shiftState != FrotzKeyboardShiftOff;
        else if (action == FrotzKeyActionCaps)
            kv.latched = _shiftState == FrotzKeyboardShiftCapsLock;
    }
}

-(void)rebuildKeys {
    [self stopRepeat];
    for (FrotzKeyView *kv in m_keyViews)
        [kv removeFromSuperview];
    [m_keyViews removeAllObjects];
    [m_touchKeys removeAllObjects];
    for (FrotzKeyboardRow *row in _layout.layers[_keyLayer]) {
        for (FrotzKeyboardKey *key in row.keys) {
            FrotzKeyView *kv = [[FrotzKeyView alloc] initWithKey: key skin: _skin];
            [self addSubview: kv];
            [m_keyViews addObject: kv];
        }
    }
    [self updateLatchedKeys];
    m_keysRebuilt = YES;
    [self setNeedsLayout];
}

#pragma mark Layout

-(void)layoutSubviews {
    [super layoutSubviews];
    CGRect rect = UIEdgeInsetsInsetRect(UIEdgeInsetsInsetRect(self.bounds, self.safeAreaInsets), _skin.bezelInsets);
    rect.origin.y += _topInset;
    rect.size.height = MAX(0, rect.size.height - _topInset);
    CGFloat gap = _layout.gap;
    NSUInteger rows = MAX(1, _layout.maxRowCount);
    CGFloat unitWidth = [self unitWidthForWidth: self.bounds.size.width];
    CGFloat keyHeight = MAX(1, (rect.size.height - (rows - 1) * gap) / rows);
    if (_fillsHeight)
        keyHeight = MIN(kMaxFillKeyHeight, keyHeight); // past this the keys stop looking like keys
    UIFont *font = [_skin fontForKeyHeight: keyHeight];
    BOOL chiclet = _skin.profile == FrotzKeyProfileChiclet;

    NSMutableArray *elements = [NSMutableArray arrayWithCapacity: m_keyViews.count];
    NSUInteger i = 0;
    CGFloat y = rect.origin.y;
    for (FrotzKeyboardRow *row in _layout.layers[_keyLayer]) {
        CGFloat x = rect.origin.x + row.indent * (unitWidth + gap);
        for (FrotzKeyboardKey *key in row.keys) {
            CGFloat w = MAX(1, key.width * unitWidth + (key.width - 1) * gap); // a sub-unit key on a cramped row
            CGRect frame = CGRectMake(round(x), round(y), round(w), round(keyHeight));
            if (chiclet)
                frame = CGRectInset(frame, round(MIN(w, keyHeight) * 0.12), round(MIN(w, keyHeight) * 0.12));
            FrotzKeyView *kv = m_keyViews[i++];
            kv.frame = frame;
            [kv setFont: font];

            FrotzKeyAccessibilityElement *element = [[FrotzKeyAccessibilityElement alloc] initWithAccessibilityContainer: self];
            element.keyView = kv;
            // A faithful space bar is blank.
            element.accessibilityLabel = key.label.length || key.action != FrotzKeyActionSpace ? key.label : @"space";
            element.accessibilityTraits = UIAccessibilityTraitKeyboardKey;
            element.accessibilityFrameInContainerSpace = frame;
            [elements addObject: element];
            x += w + gap;
        }
        y += keyHeight + gap;
    }
    self.accessibilityElements = elements;
    if (m_keysRebuilt) {
        m_keysRebuilt = NO;
        UIAccessibilityPostNotification(UIAccessibilityLayoutChangedNotification, nil);
    }
}

-(void)traitCollectionDidChange:(UITraitCollection *)previousTraitCollection {
    [super traitCollectionDidChange: previousTraitCollection];
    // Dynamic colours follow on their own; the profile layers are redrawn with the keys.
    if (self.traitCollection.userInterfaceStyle != previousTraitCollection.userInterfaceStyle)
        [self rebuildKeys];
}

#pragma mark Touches

// A key's frame plus half the gap around it, so a near miss still lands.
-(CGRect)hitRectForKey:(FrotzKeyView *)keyView {
    CGFloat slop = -_layout.gap / 2 - 1;
    return CGRectInset(keyView.frame, slop, slop);
}

-(nullable FrotzKeyView *)keyViewAtPoint:(CGPoint)pt {
    for (FrotzKeyView *kv in m_keyViews)
        if (CGRectContainsPoint([self hitRectForKey: kv], pt))
            return kv;
    return nil;
}

#if DEBUG
static NSString *PhaseName(UITouchPhase phase) {
    switch (phase) {
        case UITouchPhaseBegan: return @"began";
        case UITouchPhaseMoved: return @"moved";
        case UITouchPhaseStationary: return @"stationary";
        case UITouchPhaseEnded: return @"ended";
        case UITouchPhaseCancelled: return @"cancelled";
        default: return [NSString stringWithFormat: @"phase%ld", (long)phase];
    }
}

-(void)logTouch:(UITouch *)touch key:(nullable FrotzKeyView *)keyView {
    CGPoint pt = [touch locationInView: self];
    NSLog(@"kbtouch %@ %@ key=%@ inside=%d", PhaseName(touch.phase), NSStringFromCGPoint(pt),
          keyView ? keyView.key.label : @"(none)", keyView ? [self touch: touch isOnKey: keyView] : 0);
}
#define LOG_TOUCH(t, kv) [self logTouch: (t) key: (kv)]
#else
#define LOG_TOUCH(t, kv)
#endif

-(void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [m_feedback prepare];
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [self keyViewAtPoint: [touch locationInView: self]];
        LOG_TOUCH(touch, kv);
        if (!kv)
            continue;
        [m_touchKeys setObject: kv forKey: touch];
        [self keyTouchDown: kv touch: touch];
    }
}

-(void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    // A touch stays with the key it went down on; sliding off and releasing cancels the key,
    // and sliding off a repeating key stops it for good.
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch];
        LOG_TOUCH(touch, kv);
        if (!kv)
            continue;
        if (touch == m_repeatTouch && ![self touch: touch isOnKey: kv])
            [self stopRepeat];
        [self updatePressedForKey: kv];
    }
}

-(void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch];
        LOG_TOUCH(touch, kv);
        if (!kv)
            continue;
        BOOL inside = [self touch: touch isOnKey: kv];
        [m_touchKeys removeObjectForKey: touch];
        [self keyTouchUp: kv touch: touch inside: inside];
    }
}

-(void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch];
        LOG_TOUCH(touch, kv);
        if (!kv)
            continue;
        [m_touchKeys removeObjectForKey: touch];
        [self keyTouchUp: kv touch: touch inside: NO];
    }
}

// Against this key's own rect, not the first key whose slop holds the point (that can be a
// neighbour), and with room for the finger to roll.
-(BOOL)touch:(UITouch *)touch isOnKey:(FrotzKeyView *)keyView {
    CGFloat slop = -MAX(kReleaseSlop, _layout.gap / 2 + 1);
    return CGRectContainsPoint(CGRectInset(keyView.frame, slop, slop), [touch locationInView: self]);
}

// Lit while any touch that went down on it is still over it, so two fingers on one key
// don't put each other's highlight out.
-(void)updatePressedForKey:(FrotzKeyView *)keyView {
    BOOL pressed = NO;
    for (UITouch *touch in m_touchKeys)
        if ([m_touchKeys objectForKey: touch] == keyView && [self touch: touch isOnKey: keyView]) {
            pressed = YES;
            break;
        }
    keyView.pressed = pressed;
}

// Hidden or taken off screen: whatever was held is let go without acting, and repeats stop.
-(void)releaseAllKeys {
    [self stopRepeat];
    [m_touchKeys removeAllObjects];
    for (FrotzKeyView *kv in m_keyViews)
        kv.pressed = NO;
}

-(void)setHidden:(BOOL)hidden {
    if (hidden)
        [self releaseAllKeys];
    [super setHidden: hidden];
}

-(void)willMoveToSuperview:(UIView *)newSuperview {
    [super willMoveToSuperview: newSuperview];
    if (!newSuperview)
        [self releaseAllKeys];
}

-(void)didMoveToWindow {
    [super didMoveToWindow];
    if (!self.window)
        [self releaseAllKeys];
}

#pragma mark Keys

// Text, space, backspace and arrows act on touch down, as iOS types letters; the rest act on
// release so a slide off the key can take them back.
static BOOL ActsOnTouchDown(FrotzKeyAction action) {
    switch (action) {
        case FrotzKeyActionText: case FrotzKeyActionSpace: case FrotzKeyActionBackspace:
        case FrotzKeyActionUp: case FrotzKeyActionDown: case FrotzKeyActionLeft: case FrotzKeyActionRight:
            return YES;
        default:
            return NO;
    }
}

// touch is nil for accessibility and DEBUG taps, which press and release at once.
-(void)keyTouchDown:(FrotzKeyView *)keyView touch:(UITouch *)touch {
    keyView.pressed = YES;
    [m_feedback impactOccurred];
    FrotzKeyboardKey *key = keyView.key;
    if (!ActsOnTouchDown(key.action))
        return;
    [self performKey: key];
    // One repeat at a time, and it belongs to the touch that started it; a second finger
    // types its key once rather than take the repeat over. (A key that changed the layer is gone.)
    if (key.repeats && !m_repeatTimer && [m_keyViews containsObject: keyView]) {
        m_repeatKey = keyView;
        m_repeatTouch = touch;
        __weak FrotzKeyboardView *weakSelf = self;
        m_repeatTimer = [NSTimer scheduledTimerWithTimeInterval: kRepeatDelay repeats: NO block: ^(NSTimer *timer) {
            [weakSelf startRepeating: key];
        }];
    }
}

-(void)startRepeating:(FrotzKeyboardKey *)key {
    __weak FrotzKeyboardView *weakSelf = self;
    [self performKey: key];
    m_repeatTimer = [NSTimer scheduledTimerWithTimeInterval: kRepeatInterval repeats: YES block: ^(NSTimer *timer) {
        [weakSelf performKey: key];
    }];
}

-(void)stopRepeat {
    [m_repeatTimer invalidate];
    m_repeatTimer = nil;
    m_repeatKey = nil;
    m_repeatTouch = nil;
}

-(void)keyTouchUp:(FrotzKeyView *)keyView touch:(UITouch *)touch inside:(BOOL)inside {
    if (keyView == m_repeatKey && touch == m_repeatTouch)
        [self stopRepeat];
    [self updatePressedForKey: keyView];
    if (inside && !ActsOnTouchDown(keyView.key.action))
        [self performKey: keyView.key];
}

-(void)performKey:(FrotzKeyboardKey *)key {
    id<FrotzKeyboardViewDelegate> delegate = self.delegate;
    switch (key.action) {
        case FrotzKeyActionText:
        case FrotzKeyActionSpace:
            [delegate keyboardView: self didTypeText: key.text];
            if (_shiftState == FrotzKeyboardShiftOneShot)
                self.shiftState = FrotzKeyboardShiftOff;
            break;
        case FrotzKeyActionBackspace:
            [delegate keyboardViewDidBackspace: self];
            break;
        case FrotzKeyActionReturn:
            [delegate keyboardViewDidReturn: self];
            break;
        case FrotzKeyActionShift: {
            NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
            if (_shiftState == FrotzKeyboardShiftOff) {
                self.shiftState = FrotzKeyboardShiftOneShot;
                m_lastShiftTap = now;
            } else if (_shiftState == FrotzKeyboardShiftOneShot && now - m_lastShiftTap < kShiftDoubleTapInterval)
                self.shiftState = FrotzKeyboardShiftCapsLock;
            else
                self.shiftState = FrotzKeyboardShiftOff;
            break;
        }
        case FrotzKeyActionCaps:
            self.shiftState = _shiftState == FrotzKeyboardShiftCapsLock ? FrotzKeyboardShiftOff : FrotzKeyboardShiftCapsLock;
            break;
        case FrotzKeyActionSymbols:
            self.keyLayer = FrotzKeyboardLayerSymbols;
            break;
        case FrotzKeyActionLetters:
            self.keyLayer = _shiftState == FrotzKeyboardShiftOff ? FrotzKeyboardLayerDefault : FrotzKeyboardLayerShift;
            break;
        case FrotzKeyActionEscape:
            [delegate keyboardView: self didPressSpecialKey: FrotzKeyboardSpecialKeyEscape];
            break;
        case FrotzKeyActionUp:
            [delegate keyboardView: self didPressSpecialKey: FrotzKeyboardSpecialKeyUp];
            break;
        case FrotzKeyActionDown:
            [delegate keyboardView: self didPressSpecialKey: FrotzKeyboardSpecialKeyDown];
            break;
        case FrotzKeyActionLeft:
            [delegate keyboardView: self didPressSpecialKey: FrotzKeyboardSpecialKeyLeft];
            break;
        case FrotzKeyActionRight:
            [delegate keyboardView: self didPressSpecialKey: FrotzKeyboardSpecialKeyRight];
            break;
        case FrotzKeyActionNone:
            break;
    }
}

#if DEBUG
-(CGPoint)centerOfKeyWithLabel:(NSString *)label {
    for (FrotzKeyView *kv in m_keyViews)
        if ([kv.key.label isEqualToString: label])
            return CGPointMake(CGRectGetMidX(kv.frame), CGRectGetMidY(kv.frame));
    return CGPointMake(NAN, NAN);
}

-(nullable NSString *)labelOfKeyAtPoint:(CGPoint)pt {
    return [self keyViewAtPoint: pt].key.label;
}

-(BOOL)tapKeyWithLabel:(NSString *)label {
    for (FrotzKeyView *kv in [m_keyViews copy]) {
        if ([kv.key.label isEqualToString: label]) {
            [self keyTouchDown: kv touch: nil];
            [self keyTouchUp: kv touch: nil inside: YES];
            return YES;
        }
    }
    return NO;
}
#endif

@end
