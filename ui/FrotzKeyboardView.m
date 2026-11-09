//
//  FrotzKeyboardView.m
//  Frotz
//

#import "FrotzKeyboardView.h"

static const CGFloat kMinKeyHeight = 36, kMaxKeyHeight = 64;
static const NSTimeInterval kRepeatDelay = 0.4, kRepeatInterval = 0.08;
static const NSTimeInterval kShiftDoubleTapInterval = 0.35;

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
        m_label.text = key.label;
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
-(void)keyTouchDown:(FrotzKeyView *)keyView;
-(void)keyTouchUp:(FrotzKeyView *)keyView inside:(BOOL)inside;
@end

@implementation FrotzKeyAccessibilityElement

-(BOOL)accessibilityActivate {
    FrotzKeyboardView *keyboard = (FrotzKeyboardView *)self.accessibilityContainer;
    FrotzKeyView *keyView = self.keyView;
    if (!keyView)
        return NO;
    [keyboard keyTouchDown: keyView];
    [keyboard keyTouchUp: keyView inside: YES];
    return YES;
}

@end

#pragma mark - Keyboard

@implementation FrotzKeyboardView {
    NSMutableArray<FrotzKeyView *> *m_keyViews;
    NSMapTable<UITouch *, FrotzKeyView *> *m_touchKeys;
    NSTimer *m_repeatTimer;
    FrotzKeyView *m_repeatKey;
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

-(CGFloat)preferredHeightForWidth:(CGFloat)width {
    UIEdgeInsets bezel = _skin.bezelInsets;
    CGFloat units = MAX(1, _layout.unitsPerRow), gap = _layout.gap;
    NSUInteger rows = _layout.maxRowCount;
    CGFloat keyHeight = ((width - bezel.left - bezel.right - (units - 1) * gap) / units) / _layout.keyAspect;
    keyHeight = MIN(kMaxKeyHeight, MAX(kMinKeyHeight, keyHeight));
    return ceil(bezel.top + bezel.bottom + rows * keyHeight + (rows > 0 ? rows - 1 : 0) * gap);
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
    [self setNeedsLayout];
    UIAccessibilityPostNotification(UIAccessibilityLayoutChangedNotification, nil);
}

#pragma mark Layout

-(void)layoutSubviews {
    [super layoutSubviews];
    CGRect rect = UIEdgeInsetsInsetRect(UIEdgeInsetsInsetRect(self.bounds, self.safeAreaInsets), _skin.bezelInsets);
    CGFloat units = MAX(1, _layout.unitsPerRow), gap = _layout.gap;
    NSUInteger rows = MAX(1, _layout.maxRowCount);
    CGFloat unitWidth = (rect.size.width - (units - 1) * gap) / units;
    CGFloat keyHeight = (rect.size.height - (rows - 1) * gap) / rows;
    UIFont *font = [_skin fontForKeyHeight: keyHeight];
    BOOL chiclet = _skin.profile == FrotzKeyProfileChiclet;

    NSMutableArray *elements = [NSMutableArray arrayWithCapacity: m_keyViews.count];
    NSUInteger i = 0;
    CGFloat y = rect.origin.y;
    for (FrotzKeyboardRow *row in _layout.layers[_keyLayer]) {
        CGFloat x = rect.origin.x + row.indent * (unitWidth + gap);
        for (FrotzKeyboardKey *key in row.keys) {
            CGFloat w = key.width * unitWidth + (key.width - 1) * gap;
            CGRect frame = CGRectMake(round(x), round(y), round(w), round(keyHeight));
            if (chiclet)
                frame = CGRectInset(frame, round(MIN(w, keyHeight) * 0.12), round(MIN(w, keyHeight) * 0.12));
            FrotzKeyView *kv = m_keyViews[i++];
            kv.frame = frame;
            [kv setFont: font];

            FrotzKeyAccessibilityElement *element = [[FrotzKeyAccessibilityElement alloc] initWithAccessibilityContainer: self];
            element.keyView = kv;
            element.accessibilityLabel = key.label;
            element.accessibilityTraits = UIAccessibilityTraitKeyboardKey;
            element.accessibilityFrameInContainerSpace = frame;
            [elements addObject: element];
            x += w + gap;
        }
        y += keyHeight + gap;
    }
    self.accessibilityElements = elements;
}

-(void)traitCollectionDidChange:(UITraitCollection *)previousTraitCollection {
    [super traitCollectionDidChange: previousTraitCollection];
    // Dynamic colours follow on their own; the profile layers are redrawn with the keys.
    if (self.traitCollection.userInterfaceStyle != previousTraitCollection.userInterfaceStyle)
        [self rebuildKeys];
}

#pragma mark Touches

// The key under a point, counting half the gap around each key so a near miss still lands.
-(nullable FrotzKeyView *)keyViewAtPoint:(CGPoint)pt {
    CGFloat slop = -_layout.gap / 2 - 1;
    for (FrotzKeyView *kv in m_keyViews)
        if (CGRectContainsPoint(CGRectInset(kv.frame, slop, slop), pt))
            return kv;
    return nil;
}

-(void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [m_feedback prepare];
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [self keyViewAtPoint: [touch locationInView: self]];
        if (!kv)
            continue;
        [m_touchKeys setObject: kv forKey: touch];
        [self keyTouchDown: kv];
    }
}

-(void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    // A touch stays with the key it went down on; sliding off and releasing cancels the key.
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch];
        if (kv)
            kv.pressed = [self keyViewAtPoint: [touch locationInView: self]] == kv;
    }
}

-(void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch];
        if (!kv)
            continue;
        [m_touchKeys removeObjectForKey: touch];
        [self keyTouchUp: kv inside: [self keyViewAtPoint: [touch locationInView: self]] == kv];
    }
}

-(void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch];
        if (!kv)
            continue;
        [m_touchKeys removeObjectForKey: touch];
        [self keyTouchUp: kv inside: NO];
    }
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

-(void)keyTouchDown:(FrotzKeyView *)keyView {
    keyView.pressed = YES;
    [m_feedback impactOccurred];
    FrotzKeyboardKey *key = keyView.key;
    if (!ActsOnTouchDown(key.action))
        return;
    [self stopRepeat];
    [self performKey: key];
    if (key.repeats) {
        m_repeatKey = keyView;
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
}

-(void)keyTouchUp:(FrotzKeyView *)keyView inside:(BOOL)inside {
    keyView.pressed = NO;
    if (keyView == m_repeatKey)
        [self stopRepeat];
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
-(BOOL)tapKeyWithLabel:(NSString *)label {
    for (FrotzKeyView *kv in [m_keyViews copy]) {
        if ([kv.key.label isEqualToString: label]) {
            [self keyTouchDown: kv];
            [self keyTouchUp: kv inside: YES];
            return YES;
        }
    }
    return NO;
}
#endif

@end
