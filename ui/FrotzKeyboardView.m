//
//  FrotzKeyboardView.m
//  Frotz
//

#import "FrotzKeyboardView.h"
#import "FrotzDebugSelfTest.h"

static const CGFloat kMinKeyHeight = 36, kMaxKeyHeight = 64, kMaxFillKeyHeight = 96, kMaxCompactKeyHeight = 40;
static const NSTimeInterval kRepeatDelay = 0.4, kRepeatInterval = 0.08;
static const NSTimeInterval kShiftDoubleTapInterval = 0.35;
static const CGFloat kReleaseSlop = 16; // a finger rolls a little between down and up; only a real slide-off cancels

#pragma mark - Key view

// One key. Touches are handled by the keyboard, so a key never takes them itself.
@interface FrotzKeyView : UIView
@property (nonatomic, strong) FrotzKeyboardKey *key;
@property (nonatomic) BOOL pressed;
@property (nonatomic) BOOL latched; // shift held on for the next key or caps lock
@property (nonatomic) BOOL joinsBelow; // the top half of a two-row key: no front face or legends of its own
@property (nonatomic, weak) FrotzKeyView *joinedKey; // the other half, which lights with this one
@end

@implementation FrotzKeyView {
    FrotzKeyboardSkin *m_skin;
    UILabel *m_label, *m_sublabel, *m_shiftLabel;
    UIFont *m_sublabelFont;
    UIView *m_cap; // a cap smaller than the key, legends on the case above it (the PCjr)
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
        m_label.text = skin.upperCaseLegends && key.action == FrotzKeyActionText ? [key.label uppercaseString] : key.label;
        m_label.textAlignment = NSTextAlignmentCenter;
        m_label.adjustsFontSizeToFitWidth = YES;
        m_label.minimumScaleFactor = 0.5;
        m_label.hidden = skin.blankCaps; // the label still names the key for VoiceOver
        [self addSubview: m_label];
        if (key.sublabel) {
            m_sublabel = [[UILabel alloc] init];
            m_sublabel.text = key.sublabel;
            m_sublabel.textAlignment = NSTextAlignmentCenter;
            m_sublabel.adjustsFontSizeToFitWidth = YES;
            m_sublabel.minimumScaleFactor = 0.5;
            [self addSubview: m_sublabel];
        }
        if (key.shiftLabel) {
            m_shiftLabel = [[UILabel alloc] init];
            m_shiftLabel.text = key.shiftLabel;
            m_shiftLabel.textAlignment = NSTextAlignmentRight;
            m_shiftLabel.adjustsFontSizeToFitWidth = YES;
            m_shiftLabel.minimumScaleFactor = 0.5;
            [self addSubview: m_shiftLabel];
        }
        if (skin.capInset > 0) {
            m_cap = [[UIView alloc] init];
            m_cap.userInteractionEnabled = NO;
            [self insertSubview: m_cap atIndex: 0];
        }
        UIView *cap = m_cap ?: self;
        cap.layer.cornerRadius = skin.cornerRadius;
        if (skin.shadow) {
            cap.layer.shadowColor = [UIColor blackColor].CGColor;
            cap.layer.shadowOpacity = 0.3;
            cap.layer.shadowOffset = CGSizeMake(0, 1);
            cap.layer.shadowRadius = 0;
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
    (m_cap ?: self).backgroundColor = (_pressed || _latched) ? [m_skin pressedColorForGroup: group] : [m_skin keyColorForGroup: group];
    m_label.textColor = [m_skin textColorForGroup: group];
    UIColor *legendColor = m_cap ? m_skin.caseTextColor : m_label.textColor;
    m_sublabel.textColor = legendColor;
    m_shiftLabel.textColor = legendColor;
}

-(void)setPressed:(BOOL)pressed {
    if (pressed == _pressed)
        return;
    _pressed = pressed;
    if (pressed || UIAccessibilityIsReduceMotionEnabled())
        [UIView performWithoutAnimation: ^{ [self updateColors]; }];
    else
        [UIView animateWithDuration: 0.12 animations: ^{ [self updateColors]; }];
    self.joinedKey.pressed = pressed;
}

-(void)setLatched:(BOOL)latched {
    _latched = latched;
    [self updateColors];
}

-(void)setFont:(UIFont *)font {
    // Word legends ("return", "space") sit smaller than single characters, as on iOS.
    m_label.font = _key.label.length > 2 ? [font fontWithSize: round(font.pointSize * 0.65)] : font;
    m_sublabelFont = [font fontWithSize: round(font.pointSize * 0.45)];
    m_sublabel.font = m_sublabelFont;
    m_shiftLabel.font = m_sublabelFont;
}

// Legends are sized from the key, not Dynamic Type, but never past the line they are given.
static void FitLegendToHeight(UILabel *label) {
    CGFloat h = label.bounds.size.height;
    if (label.font && h > 0 && label.font.lineHeight > h)
        label.font = [label.font fontWithSize: MAX(1, floor(label.font.pointSize * h / label.font.lineHeight))];
}

-(void)layoutSubviews {
    [super layoutSubviews];
    [self layoutLegends];
    FitLegendToHeight(m_label);
    FitLegendToHeight(m_sublabel);
    FitLegendToHeight(m_shiftLabel);
}

-(void)layoutLegends {
    CGRect b = self.bounds;
    CGFloat edge = m_bevel && !_joinsBelow ? MAX(2, round(b.size.height * 0.08)) : 0;
    FrotzSublabelPosition position = m_skin.sublabelPosition;
    if (position == FrotzSublabelPositionFront) {
        // Front-printed legends (the C64's graphics) need a front face deep enough to hold them,
        // on every key so the row looks even; a key with no front face takes them underneath.
        if (m_bevel)
            edge = _joinsBelow ? 0 : MAX(edge, ceil(m_sublabelFont.lineHeight) + 2);
        else
            position = FrotzSublabelPositionBottom;
    }
    m_bottomEdge.hidden = _joinsBelow;
    m_label.hidden = m_skin.blankCaps || _joinsBelow;
    m_sublabel.hidden = m_shiftLabel.hidden = _joinsBelow;
    CGFloat w = b.size.width - 4, subHeight = ceil(m_sublabelFont.lineHeight);
    if (m_cap) {
        [self layoutCapWithLegendHeight: subHeight];
        return;
    }
    // The shifted character sits top right, as printed over the digits; a top sublabel shares the line, on the left.
    BOOL topLine = m_shiftLabel || (m_sublabel && position == FrotzSublabelPositionTop);
    CGFloat labelTop = topLine ? subHeight : 0;
    m_shiftLabel.frame = CGRectMake(2, 2, w, subHeight);
    if (m_sublabel) {
        if (position == FrotzSublabelPositionTop) {
            m_sublabel.textAlignment = m_shiftLabel ? NSTextAlignmentLeft : NSTextAlignmentCenter;
            m_sublabel.frame = CGRectMake(2, 2, m_shiftLabel ? w * 0.6 : w, subHeight);
            m_label.frame = CGRectMake(2, labelTop, w, b.size.height - labelTop - 2);
        } else if (position == FrotzSublabelPositionFront) {
            m_sublabel.frame = CGRectMake(2, b.size.height - edge + 1, w, subHeight);
            m_label.frame = CGRectMake(2, labelTop, w, b.size.height - edge - labelTop);
        } else {
            m_sublabel.frame = CGRectMake(2, b.size.height - edge - subHeight - 2, w, subHeight);
            m_label.frame = CGRectMake(2, labelTop, w, b.size.height - edge - subHeight - 2 - labelTop);
        }
    } else if (position == FrotzSublabelPositionFront || m_shiftLabel)
        m_label.frame = CGRectMake(2, labelTop, w, b.size.height - edge - labelTop);
    else
        m_label.frame = CGRectInset(b, 2, 0);
    if (self.layer.shadowOpacity > 0)
        self.layer.shadowPath = [UIBezierPath bezierPathWithRoundedRect: b cornerRadius: self.layer.cornerRadius].CGPath;
    if (m_bevel) {
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

// The cap is a small square (as wide as the key, on a wide key) at the bottom of the key's area,
// with the top legends printed on the case just above it. The touch area stays the whole key.
-(void)layoutCapWithLegendHeight:(CGFloat)subHeight {
    CGRect b = self.bounds;
    CGFloat inset = m_skin.capInset < 1 ? round(b.size.height * m_skin.capInset) : m_skin.capInset;
    CGFloat legend = m_sublabel || m_shiftLabel ? subHeight + 1 : 0;
    CGFloat capWidth = MAX(1, b.size.width - 2 * inset);
    CGFloat capHeight = MAX(1, MIN(b.size.height - legend - inset, b.size.width / MAX(1, _key.width) - 2 * inset));
    CGRect cap = CGRectMake(inset, b.size.height - capHeight, capWidth, capHeight);
    m_cap.frame = cap;
    if (m_cap.layer.shadowOpacity > 0)
        m_cap.layer.shadowPath = [UIBezierPath bezierPathWithRoundedRect: m_cap.bounds cornerRadius: m_cap.layer.cornerRadius].CGPath;
    CGFloat w = b.size.width - 4, legendTop = MAX(0, CGRectGetMinY(cap) - legend);
    m_shiftLabel.frame = CGRectMake(2, legendTop, w, subHeight);
    m_sublabel.textAlignment = m_shiftLabel ? NSTextAlignmentLeft : NSTextAlignmentCenter;
    m_sublabel.frame = CGRectMake(2, legendTop, m_shiftLabel ? w * 0.6 : w, subHeight);
    m_label.frame = CGRectInset(cap, 2, 0);
}

@end

#pragma mark - Accessibility

@interface FrotzKeyAccessibilityElement : UIAccessibilityElement
@property (nonatomic, weak) FrotzKeyView *keyView;
@end

// One press of a key, by a finger or (touch nil) an accessibility or DEBUG tap. What it types is
// settled when it goes down, so a repeat replays that and never what the shift or layer became since.
@interface FrotzKeyTouch : NSObject
@property (nonatomic, strong) FrotzKeyView *keyView; // moved to the same key's new view when the keys are rebuilt
@property (nonatomic, strong) FrotzKeyboardKey *key;
@property (nonatomic, copy) NSString *layer;         // the layer key came from
@end

@implementation FrotzKeyTouch
@end

@interface FrotzKeyboardView ()
-(FrotzKeyTouch *)keyTouchDown:(FrotzKeyView *)keyView touch:(nullable UITouch *)touch;
-(void)keyTouchUp:(FrotzKeyTouch *)press touch:(nullable UITouch *)touch inside:(BOOL)inside;
@end

@implementation FrotzKeyAccessibilityElement

-(BOOL)accessibilityActivate {
    FrotzKeyboardView *keyboard = (FrotzKeyboardView *)self.accessibilityContainer;
    FrotzKeyView *keyView = self.keyView;
    if (!keyView)
        return NO;
    FrotzKeyTouch *press = [keyboard keyTouchDown: keyView touch: nil];
    [keyboard keyTouchUp: press touch: nil inside: YES];
    return YES;
}

@end

#pragma mark - Keyboard

@implementation FrotzKeyboardView {
    FrotzKeyboardLayout *m_rows;   // the layout or its compact form, whichever is showing
    NSMutableArray<FrotzKeyView *> *m_keyViews;
    NSMapTable<UITouch *, FrotzKeyTouch *> *m_touchKeys;
    NSTimer *m_repeatTimer;
    FrotzKeyTouch *m_repeatPress; // the finger's press that owns the repeat
    BOOL m_keysRebuilt;        // tell VoiceOver once the new elements are in place
    NSTimeInterval m_lastShiftTap;
    UIImpactFeedbackGenerator *m_feedback;
    UITouch *m_layerTouch;      // a held key that used up a one-shot shift keeps its layer until it lets go,
    NSString *m_pendingLayer;   // so it can still repeat; this is the layer to show then
    BOOL m_inTouchDown;
    NSString *m_announcement;   // for VoiceOver once a layer or shift change is on screen
    CGRect m_keysFrame;         // the keys' extent, the keyboard's accessibility frame
}

-(instancetype)initWithLayout:(FrotzKeyboardLayout *)layout skin:(FrotzKeyboardSkin *)skin {
    if ((self = [super initWithFrame: CGRectZero])) {
        _layout = layout;
        m_rows = layout;
        _skin = skin;
        _keyLayer = [FrotzKeyboardLayerDefault copy];
        self.backgroundColor = skin.caseColor;
        self.multipleTouchEnabled = YES;
        m_keyViews = [NSMutableArray array];
        m_touchKeys = [NSMapTable strongToStrongObjectsMapTable];
        m_feedback = [[UIImpactFeedbackGenerator alloc] initWithStyle: UIImpactFeedbackStyleLight];
        self.accessibilityLabel = layout.name;
        self.accessibilityContainerType = UIAccessibilityContainerTypeSemanticGroup;
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
    return [self unitWidthForWidth: width rows: m_rows];
}

-(CGFloat)unitWidthForWidth:(CGFloat)width rows:(FrotzKeyboardLayout *)layout {
    UIEdgeInsets safe = self.safeAreaInsets, bezel = _skin.bezelInsets;
    CGFloat units = MAX(1, layout.unitsPerRow), gap = layout.gap;
    return MAX(1, (width - safe.left - safe.right - bezel.left - bezel.right - (units - 1) * gap) / units);
}

-(CGFloat)preferredHeightForWidth:(CGFloat)width {
    return [self preferredHeightForWidth: width compact: _compact];
}

// Asks without switching rows, which would let go of any key held down.
-(CGFloat)preferredHeightForWidth:(CGFloat)width compact:(BOOL)compact {
    FrotzKeyboardLayout *layout = compact && _layout.compactLayout ? _layout.compactLayout : _layout;
    UIEdgeInsets bezel = _skin.bezelInsets;
    CGFloat gap = layout.gap;
    NSUInteger rows = layout.maxRowCount;
    CGFloat keyHeight = [self unitWidthForWidth: width rows: layout] / layout.keyAspect;
    keyHeight = MIN(compact ? kMaxCompactKeyHeight : kMaxKeyHeight, MAX(kMinKeyHeight, keyHeight));
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

-(void)setCompact:(BOOL)compact {
    FrotzKeyboardLayout *rows = compact && _layout.compactLayout ? _layout.compactLayout : _layout;
    _compact = compact;
    if (rows == m_rows)
        return;
    [self releaseAllKeys]; // the keys under any finger are about to go
    m_rows = rows;
    if (!m_rows.layers[_keyLayer])
        _keyLayer = [FrotzKeyboardLayerDefault copy];
    [self rebuildKeysFromRows: nil];
}

#pragma mark Layers and shift

-(void)setKeyLayer:(NSString *)layer {
    if (!m_rows.layers[layer])
        return;
    if (m_layerTouch || m_inTouchDown) {
        m_pendingLayer = [layer isEqualToString: _keyLayer] ? nil : [layer copy];
        return;
    }
    if ([layer isEqualToString: _keyLayer])
        return;
    NSArray<FrotzKeyboardRow *> *oldRows = m_rows.layers[_keyLayer];
    _keyLayer = [layer copy];
    [self rebuildKeysFromRows: oldRows];
}

-(void)showPendingLayer {
    m_layerTouch = nil;
    NSString *layer = m_pendingLayer;
    m_pendingLayer = nil;
    if (layer)
        self.keyLayer = layer;
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

// Where the key at this index in one layer's rows sits in another's: the same row and place, if
// it is the same width there.
static NSUInteger CorrespondingKeyIndex(NSArray<FrotzKeyboardRow *> *from, NSArray<FrotzKeyboardRow *> *to, NSUInteger index) {
    NSUInteger start = 0, toStart = 0;
    for (NSUInteger r = 0; r < from.count && r < to.count; r++) {
        NSArray<FrotzKeyboardKey *> *keys = from[r].keys, *other = to[r].keys;
        if (index < start + keys.count) {
            NSUInteger k = index - start;
            return k < other.count && other[k].width == keys[k].width ? toStart + k : NSNotFound;
        }
        start += keys.count;
        toStart += other.count;
    }
    return NSNotFound;
}

-(void)rebuildKeys {
    [self rebuildKeysFromRows: m_rows.layers[_keyLayer]];
}

// oldRows are the rows the current key views were built from, so held keys can find their place.
-(void)rebuildKeysFromRows:(nullable NSArray<FrotzKeyboardRow *> *)oldRows {
    NSArray<FrotzKeyView *> *oldViews = [m_keyViews copy];
    // A layer waiting on a held key is shown now, so nothing is left to wait for.
    m_layerTouch = nil;
    if (m_pendingLayer) {
        _keyLayer = m_pendingLayer;
        m_pendingLayer = nil;
    }
    for (FrotzKeyView *kv in m_keyViews)
        [kv removeFromSuperview];
    [m_keyViews removeAllObjects];
    NSArray<FrotzKeyboardRow *> *rows = m_rows.layers[_keyLayer];
    for (FrotzKeyboardRow *row in rows) {
        for (FrotzKeyboardKey *key in row.keys) {
            FrotzKeyView *kv = [[FrotzKeyView alloc] initWithKey: key skin: _skin];
            [self addSubview: kv];
            [m_keyViews addObject: kv];
        }
    }
    // Fingers still down keep their press, what it types and its repeat. Each moves to the key in
    // the same place in the new layer, else one with the same label; with neither it keeps the old
    // key's frame to slide off or release on.
    for (UITouch *touch in m_touchKeys) {
        FrotzKeyTouch *press = [m_touchKeys objectForKey: touch];
        NSUInteger index = oldRows ? [oldViews indexOfObject: press.keyView] : NSNotFound;
        NSUInteger newIndex = index == NSNotFound ? NSNotFound : CorrespondingKeyIndex(oldRows, rows, index);
        FrotzKeyView *kv = newIndex != NSNotFound ? m_keyViews[newIndex] : [self keyViewWithLabel: press.keyView.key.label];
        if (kv) {
            press.keyView = kv;
            kv.pressed = YES;
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
    CGFloat gap = m_rows.gap;
    NSUInteger rows = MAX(1, m_rows.maxRowCount);
    CGFloat unitWidth = [self unitWidthForWidth: self.bounds.size.width];
    CGFloat keyHeight = MAX(1, (rect.size.height - (rows - 1) * gap) / rows);
    if (_fillsHeight)
        keyHeight = MIN(kMaxFillKeyHeight, keyHeight); // past this the keys stop looking like keys
    if (_compact)
        keyHeight = MIN(kMaxCompactKeyHeight, keyHeight);
    UIFont *font = [_skin fontForKeyHeight: keyHeight];
    BOOL chiclet = _skin.profile == FrotzKeyProfileChiclet;

    NSMutableArray *elements = [NSMutableArray arrayWithCapacity: m_keyViews.count];
    m_keysFrame = CGRectNull;
    NSMutableArray<FrotzKeyAccessibilityElement *> *aboveRow = [NSMutableArray array], *thisRow = [NSMutableArray array];
    NSUInteger i = 0;
    CGFloat y = rect.origin.y;
    for (FrotzKeyboardRow *row in m_rows.layers[_keyLayer]) {
        CGFloat x = rect.origin.x + row.indent * (unitWidth + gap);
        for (FrotzKeyboardKey *key in row.keys) {
            CGFloat w = MAX(1, key.width * unitWidth + (key.width - 1) * gap); // a sub-unit key on a cramped row
            CGRect frame = CGRectMake(round(x), round(y), round(w), round(keyHeight));
            if (chiclet)
                frame = CGRectInset(frame, round(MIN(w, keyHeight) * 0.12), round(MIN(w, keyHeight) * 0.12));
            FrotzKeyView *kv = m_keyViews[i++];
            kv.frame = frame;
            [kv setFont: font];
            m_keysFrame = CGRectUnion(m_keysFrame, frame);

            FrotzKeyAccessibilityElement *element = [[FrotzKeyAccessibilityElement alloc] initWithAccessibilityContainer: self];
            element.keyView = kv;
            element.accessibilityLabel = key.accessibilityName;
            element.accessibilityTraits = UIAccessibilityTraitKeyboardKey;
            element.accessibilityFrameInContainerSpace = frame;
            [thisRow addObject: element];
            FrotzKeyAccessibilityElement *upper = [self joinReturnKey: kv toRowAbove: aboveRow];
            if (upper)
                upper.accessibilityFrameInContainerSpace = CGRectUnion(upper.keyView.frame, frame);
            else
                [elements addObject: element];
            x += w + gap;
        }
        aboveRow = thisRow;
        thisRow = [NSMutableArray array];
        y += keyHeight + gap;
    }
    self.accessibilityElements = elements;
    if (m_keysRebuilt) {
        m_keysRebuilt = NO;
        UIAccessibilityPostNotification(UIAccessibilityLayoutChangedNotification, m_announcement);
        m_announcement = nil;
    }
}

// The keys, not the case around them or the fold band above them in a split.
-(CGRect)accessibilityFrame {
    CGRect keys = CGRectIsNull(m_keysFrame) ? self.bounds : m_keysFrame;
    UIWindow *window = self.window;
    if (!window)
        return [super accessibilityFrame];
    return [window convertRect: [self convertRect: keys toView: nil] toCoordinateSpace: window.screen.coordinateSpace];
}

// Says what a Shift, caps or layer key did: with the new keys' layout change when they were
// rebuilt for it, otherwise (a skin with no shift layer) on its own.
-(void)announceKeyboardState:(NSString *)announcement {
#if DEBUG
    [FrotzDebugSelfTest keyboardView: self willAnnounce: announcement withLayoutChange: m_keysRebuilt];
#endif
    if (!UIAccessibilityIsVoiceOverRunning())
        return;
    if (m_keysRebuilt)
        m_announcement = announcement;
    else
        UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification, announcement);
}

-(NSString *)shiftAnnouncement {
    switch (_shiftState) {
        case FrotzKeyboardShiftOneShot: return NSLocalizedString(@"Shift on", nil);
        case FrotzKeyboardShiftCapsLock: return NSLocalizedString(@"Caps lock on", nil);
        default: return NSLocalizedString(@"Shift off", nil);
    }
}

// Two "return" group keys stacked in neighbouring rows with their right edges in line are one
// key, as the IBM's tall Return: the upper half reaches down over the gap and the pair lights as one.
-(nullable FrotzKeyAccessibilityElement *)joinReturnKey:(FrotzKeyView *)lower toRowAbove:(NSArray<FrotzKeyAccessibilityElement *> *)aboveRow {
    lower.joinedKey = nil;
    lower.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner | kCALayerMinXMaxYCorner | kCALayerMaxXMaxYCorner;
    if (![lower.key.group isEqualToString: @"return"])
        return nil;
    for (FrotzKeyAccessibilityElement *element in aboveRow) {
        FrotzKeyView *upper = element.keyView;
        if (![upper.key.group isEqualToString: @"return"] || upper.key.action != lower.key.action
            || fabs(CGRectGetMaxX(upper.frame) - CGRectGetMaxX(lower.frame)) > 1)
            continue;
        upper.joinsBelow = YES;
        upper.joinedKey = lower;
        lower.joinedKey = upper;
        // Down past the lower half's top highlight, so no seam shows.
        CGRect frame = upper.frame;
        frame.size.height = CGRectGetMinY(lower.frame) + 2 - frame.origin.y;
        upper.frame = frame;
        upper.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
        CACornerMask lowerCorners = kCALayerMinXMaxYCorner | kCALayerMaxXMaxYCorner;
        if (CGRectGetMinX(lower.frame) < CGRectGetMinX(upper.frame) - 1)
            lowerCorners |= kCALayerMinXMinYCorner; // an L: the lower half sticks out on the left
        lower.layer.maskedCorners = lowerCorners;
        if (upper.pressed != lower.pressed) { // a held half remapped before the join; light both
            upper.pressed = YES;
            lower.pressed = YES;
        }
        [self bringSubviewToFront: upper];
        [upper setNeedsLayout];
        return element;
    }
    return nil;
}

-(void)traitCollectionDidChange:(UITraitCollection *)previousTraitCollection {
    [super traitCollectionDidChange: previousTraitCollection];
    // Dynamic colours follow on their own; the profile layers are redrawn with the keys.
    if (self.traitCollection.userInterfaceStyle != previousTraitCollection.userInterfaceStyle)
        [self rebuildKeys];
}

#pragma mark Touches

// A key's frame plus half the gap around it, so a near miss still lands, but never into the
// bottom safe area: a touch that starts at the screen's edge is the home gesture's.
-(CGRect)hitRectForKey:(FrotzKeyView *)keyView {
    CGFloat slop = -m_rows.gap / 2 - 1;
    CGRect rect = CGRectInset(keyView.frame, slop, slop);
    CGFloat bottom = CGRectGetMaxY(self.bounds) - self.safeAreaInsets.bottom;
    rect.size.height = MAX(0, MIN(CGRectGetMaxY(rect), bottom) - CGRectGetMinY(rect));
    return rect;
}

-(nullable FrotzKeyView *)keyViewAtPoint:(CGPoint)pt {
    for (FrotzKeyView *kv in m_keyViews)
        if (CGRectContainsPoint([self hitRectForKey: kv], pt))
            return kv;
    return nil;
}

-(void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [m_feedback prepare];
    for (UITouch *touch in touches) {
        FrotzKeyView *kv = [self keyViewAtPoint: [touch locationInView: self]];
        if (kv)
            [self keyTouchDown: kv touch: touch];
    }
}

-(void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    // A touch stays with the key it went down on; sliding off and releasing cancels the key,
    // and sliding off a repeating key stops it for good.
    for (UITouch *touch in touches) {
        FrotzKeyTouch *press = [m_touchKeys objectForKey: touch];
        if (!press)
            continue;
        if (press == m_repeatPress && ![self touch: touch isOnKey: press.keyView])
            [self stopRepeat];
        [self updatePressedForKey: press.keyView];
    }
}

-(void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *touch in touches) {
        FrotzKeyTouch *press = [m_touchKeys objectForKey: touch];
        if (!press)
            continue;
        BOOL inside = [self touch: touch isOnKey: press.keyView];
        [m_touchKeys removeObjectForKey: touch];
        [self keyTouchUp: press touch: touch inside: inside];
    }
}

-(void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    for (UITouch *touch in touches) {
        FrotzKeyTouch *press = [m_touchKeys objectForKey: touch];
        if (!press)
            continue;
        [m_touchKeys removeObjectForKey: touch];
        [self keyTouchUp: press touch: touch inside: NO];
    }
}

// Against this key's own rect, not the first key whose slop holds the point (that can be a
// neighbour), and with room for the finger to roll. The two halves of a joined key (the IBM's
// tall Return) are one place to press, so moving from one to the other doesn't take it back.
-(BOOL)touch:(UITouch *)touch isOnKey:(FrotzKeyView *)keyView {
    return [self point: [touch locationInView: self] isOnKey: keyView];
}

-(BOOL)point:(CGPoint)pt isOnKey:(FrotzKeyView *)keyView {
    CGFloat slop = -MAX(kReleaseSlop, m_rows.gap / 2 + 1);
    if (CGRectContainsPoint(CGRectInset(keyView.frame, slop, slop), pt))
        return YES;
    FrotzKeyView *other = keyView.joinedKey;
    return other && CGRectContainsPoint(CGRectInset(other.frame, slop, slop), pt);
}

// Lit while any touch that went down on it is still over it, so two fingers on one key
// don't put each other's highlight out.
-(void)updatePressedForKey:(FrotzKeyView *)keyView {
    BOOL pressed = NO;
    for (UITouch *touch in m_touchKeys) {
        FrotzKeyView *kv = [m_touchKeys objectForKey: touch].keyView;
        if ((kv == keyView || kv == keyView.joinedKey) && [self touch: touch isOnKey: kv]) {
            pressed = YES;
            break;
        }
    }
    keyView.pressed = pressed;
}

// Hidden or taken off screen: whatever was held is let go without acting, and repeats stop.
-(void)releaseAllKeys {
    [self stopRepeat];
    [m_touchKeys removeAllObjects];
    for (FrotzKeyView *kv in m_keyViews)
        kv.pressed = NO;
    [self showPendingLayer];
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

// While a held key keeps the old layer on screen, another key types what the new layer has there.
-(FrotzKeyboardKey *)keyForView:(FrotzKeyView *)keyView layer:(NSString *__autoreleasing *)layer {
    *layer = _keyLayer;
    if (!m_pendingLayer)
        return keyView.key;
    NSArray<FrotzKeyboardRow *> *pending = m_rows.layers[m_pendingLayer];
    NSUInteger index = [m_keyViews indexOfObject: keyView];
    index = index == NSNotFound ? NSNotFound : CorrespondingKeyIndex(m_rows.layers[_keyLayer], pending, index);
    if (index == NSNotFound)
        return keyView.key;
    for (FrotzKeyboardRow *row in pending) {
        if (index < row.keys.count) {
            *layer = m_pendingLayer;
            return row.keys[index];
        }
        index -= row.keys.count;
    }
    return keyView.key;
}

-(nullable FrotzKeyView *)keyViewWithLabel:(NSString *)label {
    for (FrotzKeyView *kv in m_keyViews)
        if ([kv.key.label isEqualToString: label])
            return kv;
    return nil;
}

// touch is nil for accessibility and DEBUG taps, which press and release at once; a finger's
// press is kept against its touch until it lets go.
-(FrotzKeyTouch *)keyTouchDown:(FrotzKeyView *)keyView touch:(UITouch *)touch {
    keyView.pressed = YES;
    [m_feedback impactOccurred];
    FrotzKeyTouch *press = [[FrotzKeyTouch alloc] init];
    press.keyView = keyView;
    NSString *layer;
    press.key = [self keyForView: keyView layer: &layer];
    press.layer = layer;
    if (touch)
        [m_touchKeys setObject: press forKey: touch];
    if (!ActsOnTouchDown(press.key.action))
        return press;
    // A key that uses up a one-shot shift resolves as shifted now and keeps its layer on screen
    // until it lets go.
    m_inTouchDown = touch != nil;
    [self performKey: press.key fromLayer: press.layer repeat: NO];
    m_inTouchDown = NO;
    if (m_pendingLayer && !m_layerTouch)
        m_layerTouch = touch;
    // One repeat at a time, and it belongs to the finger that started it; a second finger types
    // its key once rather than take the repeat over.
    if (touch && press.key.repeats && !m_repeatTimer) {
        m_repeatPress = press;
        __weak FrotzKeyboardView *weakSelf = self;
        m_repeatTimer = [NSTimer scheduledTimerWithTimeInterval: kRepeatDelay repeats: NO block: ^(NSTimer *timer) {
            [weakSelf startRepeating];
        }];
    }
    return press;
}

-(void)startRepeating {
    __weak FrotzKeyboardView *weakSelf = self;
    [self repeatOnce];
    m_repeatTimer = [NSTimer scheduledTimerWithTimeInterval: kRepeatInterval repeats: YES block: ^(NSTimer *timer) {
        [weakSelf repeatOnce];
    }];
}

// The press as it went down, again; a repeat never uses up a shift armed since.
-(void)repeatOnce {
    FrotzKeyTouch *press = m_repeatPress;
    if (press)
        [self performKey: press.key fromLayer: press.layer repeat: YES];
}

-(void)stopRepeat {
    [m_repeatTimer invalidate];
    m_repeatTimer = nil;
    m_repeatPress = nil;
}

-(void)keyTouchUp:(FrotzKeyTouch *)press touch:(UITouch *)touch inside:(BOOL)inside {
    if (press == m_repeatPress)
        [self stopRepeat];
    [self updatePressedForKey: press.keyView];
    if (inside && !ActsOnTouchDown(press.key.action))
        [self performKey: press.key fromLayer: press.layer repeat: NO];
    if (touch && touch == m_layerTouch)
        [self showPendingLayer];
}

static FrotzKeyboardSpecialKey SpecialKeyForArrow(FrotzKeyAction action) {
    switch (action) {
        case FrotzKeyActionUp: return FrotzKeyboardSpecialKeyUp;
        case FrotzKeyActionDown: return FrotzKeyboardSpecialKeyDown;
        case FrotzKeyActionLeft: return FrotzKeyboardSpecialKeyLeft;
        default: return FrotzKeyboardSpecialKeyRight;
    }
}

// layer is the one the key came from; repeat is a held key's repeat, which only sends the key again.
-(void)performKey:(FrotzKeyboardKey *)key fromLayer:(NSString *)layer repeat:(BOOL)repeat {
    id<FrotzKeyboardViewDelegate> delegate = self.delegate;
#if DEBUG
    [FrotzDebugSelfTest keyboardView: self willPerformKey: key];
#endif
    switch (key.action) {
        case FrotzKeyActionText:
        case FrotzKeyActionSpace:
            [delegate keyboardView: self didTypeText: key.text];
            if (!repeat && _shiftState == FrotzKeyboardShiftOneShot)
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
            [self announceKeyboardState: [self shiftAnnouncement]];
            break;
        }
        case FrotzKeyActionCaps:
            self.shiftState = _shiftState == FrotzKeyboardShiftCapsLock ? FrotzKeyboardShiftOff : FrotzKeyboardShiftCapsLock;
            [self announceKeyboardState: [self shiftAnnouncement]];
            break;
        case FrotzKeyActionSymbols:
            self.keyLayer = FrotzKeyboardLayerSymbols;
            [self announceKeyboardState: NSLocalizedString(@"Symbols", nil)];
            break;
        case FrotzKeyActionLetters:
            self.keyLayer = _shiftState == FrotzKeyboardShiftOff ? FrotzKeyboardLayerDefault : FrotzKeyboardLayerShift;
            [self announceKeyboardState: NSLocalizedString(@"Letters", nil)];
            break;
        case FrotzKeyActionEscape:
            [delegate keyboardView: self didPressSpecialKey: FrotzKeyboardSpecialKeyEscape];
            break;
        case FrotzKeyActionUp:
        case FrotzKeyActionDown:
        case FrotzKeyActionLeft:
        case FrotzKeyActionRight:
            [delegate keyboardView: self didPressSpecialKey: SpecialKeyForArrow(key.action)];
            // A shifted cursor key (the C64's up and left) uses the shift up, as a letter does; an
            // arrow off the shift layer (Classic's, in its symbols) leaves it for the next letter.
            if (!repeat && _shiftState == FrotzKeyboardShiftOneShot && [layer isEqualToString: FrotzKeyboardLayerShift])
                self.shiftState = FrotzKeyboardShiftOff;
            break;
        case FrotzKeyActionNone:
            break;
    }
}

@end
