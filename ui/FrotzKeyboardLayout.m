//
//  FrotzKeyboardLayout.m
//  Frotz
//

#import "FrotzKeyboardLayout.h"

NSString *const FrotzKeyboardLayerDefault = @"default";
NSString *const FrotzKeyboardLayerShift = @"shift";
NSString *const FrotzKeyboardLayerSymbols = @"symbols";

static NSString *const kKeyboardsFolder = @"keyboards";
static const CGFloat kNominalKeyHeight = 44; // the height a skin's fontSize is designed for

// Skins are hand-written data; say once what is wrong with one rather than on every load.
static void LogMalformed(NSString *file, NSString *itemID, NSString *why) {
    static NSMutableSet *logged;
    if (!logged)
        logged = [NSMutableSet set];
    NSString *key = [NSString stringWithFormat: @"%@/%@", itemID, file];
    if ([logged containsObject: key])
        return;
    [logged addObject: key];
    NSLog(@"Frotz keyboard %@: %@; using the system keyboard", key, why);
}

static NSDictionary *LoadKeyboardJSON(NSString *itemID, NSString *file) {
    NSString *dir = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent: kKeyboardsFolder];
    NSString *path = [[dir stringByAppendingPathComponent: itemID] stringByAppendingPathComponent: file];
    NSData *data = [NSData dataWithContentsOfFile: path];
    if (!data) {
        LogMalformed(file, itemID, @"not found");
        return nil;
    }
    NSError *error = nil;
    id obj = [NSJSONSerialization JSONObjectWithData: data options: 0 error: &error];
    if (![obj isKindOfClass: [NSDictionary class]]) {
        LogMalformed(file, itemID, error ? [error localizedDescription] : @"not a JSON object");
        return nil;
    }
    return obj;
}

// Optional fields: an absent one keeps its default, but one that is present and wrong spoils the
// file. Problems collect in *error, and the first one found is the one reported.
static void Fail(NSString **error, NSString *why) {
    if (!*error)
        *error = why;
}

static id Optional(NSDictionary *dict, NSString *key, Class cls, NSString **error) {
    id value = dict[key];
    if (!value)
        return nil;
    // JSON true/false arrive as NSNumber; a number field wants a real number.
    BOOL isBool = CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
    if (![value isKindOfClass: cls] || (isBool && cls == [NSNumber class])) {
        NSString *kind = cls == [NSString class] ? @"a string" : cls == [NSNumber class] ? @"a number"
                       : cls == [NSArray class] ? @"an array" : @"an object";
        Fail(error, [NSString stringWithFormat: @"\"%@\" is not %@", key, kind]);
        return nil;
    }
    return value;
}

static NSNumber *OptionalBool(NSDictionary *dict, NSString *key, NSString **error) {
    id value = dict[key];
    if (value && ![value isKindOfClass: [NSNumber class]]) {
        Fail(error, [NSString stringWithFormat: @"\"%@\" is not true or false", key]);
        return nil;
    }
    return value;
}

static CGFloat OptionalNumber(NSDictionary *dict, NSString *key, CGFloat fallback, NSString **error) {
    NSNumber *n = Optional(dict, key, [NSNumber class], error);
    return n ? [n doubleValue] : fallback;
}

// "#RRGGBB" and nothing else.
static UIColor *ColorFromHex(id value) {
    static NSRegularExpression *pattern;
    if (!pattern)
        pattern = [NSRegularExpression regularExpressionWithPattern: @"^#[0-9A-Fa-f]{6}$" options: 0 error: nil];
    if (![value isKindOfClass: [NSString class]]
        || ![pattern firstMatchInString: value options: 0 range: NSMakeRange(0, [value length])])
        return nil;
    unsigned int rgb = 0;
    [[NSScanner scannerWithString: [value substringFromIndex: 1]] scanHexInt: &rgb];
    return [UIColor colorWithRed: ((rgb >> 16) & 0xFF) / 255.0 green: ((rgb >> 8) & 0xFF) / 255.0
                            blue: (rgb & 0xFF) / 255.0 alpha: 1.0];
}

static UIColor *OptionalColor(NSDictionary *dict, NSString *key, NSString **error) {
    id value = dict[key];
    if (!value)
        return nil;
    UIColor *color = ColorFromHex(value);
    if (!color)
        Fail(error, [NSString stringWithFormat: @"\"%@\" is not #RRGGBB", key]);
    return color;
}

// A light/dark pair from {"light": ..., "dark": ...}; a missing dark uses light. Nil if light is absent.
static UIColor *DynamicColor(NSDictionary *dict, NSString *lightKey, NSString *darkKey, NSString **error) {
    UIColor *light = OptionalColor(dict, lightKey, error);
    UIColor *dark = OptionalColor(dict, darkKey, error);
    if (dark && !dict[lightKey])
        Fail(error, [NSString stringWithFormat: @"\"%@\" without \"%@\"", darkKey, lightKey]);
    if (!light)
        return nil;
    dark = dark ?: light;
    return [UIColor colorWithDynamicProvider: ^UIColor *(UITraitCollection *tc) {
        return tc.userInterfaceStyle == UIUserInterfaceStyleDark ? dark : light;
    }];
}

#pragma mark - Keys and rows

@interface FrotzKeyboardKey ()
-(instancetype)initWithLabel:(NSString *)label text:(NSString *)text action:(FrotzKeyAction)action width:(CGFloat)width
                       group:(NSString *)group repeats:(BOOL)repeats sublabel:(nullable NSString *)sublabel NS_DESIGNATED_INITIALIZER;
-(instancetype)init NS_UNAVAILABLE;
@end

@implementation FrotzKeyboardKey

-(instancetype)initWithLabel:(NSString *)label text:(NSString *)text action:(FrotzKeyAction)action width:(CGFloat)width
                       group:(NSString *)group repeats:(BOOL)repeats sublabel:(NSString *)sublabel {
    if ((self = [super init])) {
        _label = [label copy];
        _text = [text copy];
        _action = action;
        _width = width;
        _group = [group copy];
        _repeats = repeats;
        _sublabel = [sublabel copy];
    }
    return self;
}

+(NSDictionary<NSString *, NSNumber *> *)actionNames {
    static NSDictionary *names;
    if (!names)
        names = @{ @"text": @(FrotzKeyActionText), @"backspace": @(FrotzKeyActionBackspace), @"return": @(FrotzKeyActionReturn),
                   @"shift": @(FrotzKeyActionShift), @"caps": @(FrotzKeyActionCaps), @"symbols": @(FrotzKeyActionSymbols),
                   @"letters": @(FrotzKeyActionLetters), @"space": @(FrotzKeyActionSpace), @"escape": @(FrotzKeyActionEscape),
                   @"up": @(FrotzKeyActionUp), @"down": @(FrotzKeyActionDown), @"left": @(FrotzKeyActionLeft),
                   @"right": @(FrotzKeyActionRight), @"none": @(FrotzKeyActionNone) };
    return names;
}

+(nullable instancetype)keyWithJSON:(id)json error:(NSString **)error {
    if (![json isKindOfClass: [NSDictionary class]]) {
        Fail(error, @"a key is not an object");
        return nil;
    }
    NSDictionary *dict = json;
    NSString *label = Optional(dict, @"label", [NSString class], error);
    if (!label) {
        Fail(error, @"a key has no label");
        return nil;
    }
    NSString *actionName = Optional(dict, @"action", [NSString class], error) ?: @"text";
    NSNumber *action = [self actionNames][actionName];
    if (!action)
        Fail(error, [NSString stringWithFormat: @"unknown action \"%@\"", actionName]);
    FrotzKeyAction a = [action integerValue];
    NSString *text = Optional(dict, @"text", [NSString class], error);
    if (!text)
        text = a == FrotzKeyActionSpace ? @" " : label;
    BOOL repeatsByDefault = (a == FrotzKeyActionBackspace || a == FrotzKeyActionUp || a == FrotzKeyActionDown
                             || a == FrotzKeyActionLeft || a == FrotzKeyActionRight);
    NSNumber *repeats = OptionalBool(dict, @"repeat", error);
    CGFloat width = OptionalNumber(dict, @"width", 1, error);
    if (width <= 0)
        Fail(error, @"a key has a width of zero or less");
    NSString *group = Optional(dict, @"group", [NSString class], error) ?: @"alpha";
    NSString *sublabel = Optional(dict, @"sublabel", [NSString class], error);
    if (*error) {
        *error = [NSString stringWithFormat: @"key \"%@\": %@", label, *error];
        return nil;
    }
    return [[self alloc] initWithLabel: label text: text action: a width: width group: group
                               repeats: repeats ? [repeats boolValue] : repeatsByDefault sublabel: sublabel];
}

-(FrotzKeyboardKey *)upperCasedKey {
    if (_action != FrotzKeyActionText)
        return self;
    return [[FrotzKeyboardKey alloc] initWithLabel: [_label uppercaseString] text: [_text uppercaseString] action: _action
                                             width: _width group: _group repeats: _repeats sublabel: _sublabel];
}

@end

@interface FrotzKeyboardRow ()
-(instancetype)initWithIndent:(CGFloat)indent keys:(NSArray<FrotzKeyboardKey *> *)keys NS_DESIGNATED_INITIALIZER;
-(instancetype)init NS_UNAVAILABLE;
@end

@implementation FrotzKeyboardRow

-(instancetype)initWithIndent:(CGFloat)indent keys:(NSArray<FrotzKeyboardKey *> *)keys {
    if ((self = [super init])) {
        _indent = indent;
        _keys = [keys copy];
    }
    return self;
}

-(CGFloat)units {
    CGFloat units = _indent;
    for (FrotzKeyboardKey *key in _keys)
        units += key.width;
    return units;
}

@end

#pragma mark - Layout

@implementation FrotzKeyboardLayout

static NSArray<FrotzKeyboardRow *> *ParseRows(id json, NSString **error) {
    if (![json isKindOfClass: [NSArray class]] || [json count] == 0) {
        Fail(error, @"a layer is not a non-empty array of rows");
        return nil;
    }
    NSMutableArray *rows = [NSMutableArray array];
    for (id rowJSON in json) {
        if (![rowJSON isKindOfClass: [NSDictionary class]] || ![rowJSON[@"keys"] isKindOfClass: [NSArray class]]
            || [rowJSON[@"keys"] count] == 0) {
            Fail(error, @"a row has no keys");
            return nil;
        }
        CGFloat indent = OptionalNumber(rowJSON, @"indent", 0, error);
        if (indent < 0)
            Fail(error, @"a row has a negative indent");
        if (*error)
            return nil;
        NSMutableArray *keys = [NSMutableArray array];
        for (id keyJSON in rowJSON[@"keys"]) {
            FrotzKeyboardKey *key = [FrotzKeyboardKey keyWithJSON: keyJSON error: error];
            if (!key)
                return nil;
            [keys addObject: key];
        }
        [rows addObject: [[FrotzKeyboardRow alloc] initWithIndent: indent keys: keys]];
    }
    return rows;
}

+(instancetype)layoutWithID:(NSString *)layoutID {
    NSDictionary *json = LoadKeyboardJSON(layoutID, @"layout.json");
    if (!json)
        return nil;
    NSString *error = nil;
    NSString *name = Optional(json, @"name", [NSString class], &error) ?: layoutID;
    CGFloat keyAspect = OptionalNumber(json, @"keyAspect", 1.0, &error);
    if (keyAspect <= 0)
        Fail(&error, @"keyAspect is zero or less");
    CGFloat gap = OptionalNumber(json, @"gap", 6, &error);
    if (gap < 0)
        Fail(&error, @"gap is negative");
    NSDictionary *layersJSON = Optional(json, @"layers", [NSDictionary class], &error);
    NSMutableDictionary *layers = [NSMutableDictionary dictionary];
    for (NSString *layerName in layersJSON) {
        if (error)
            break;
        NSArray *rows = ParseRows(layersJSON[layerName], &error);
        if (!rows)
            error = [NSString stringWithFormat: @"layer \"%@\": %@", layerName, error];
        else
            layers[layerName] = rows;
    }
    NSArray<FrotzKeyboardRow *> *defaultRows = layers[FrotzKeyboardLayerDefault];
    if (!defaultRows)
        Fail(&error, @"no default layer");
    if (error) {
        LogMalformed(@"layout.json", layoutID, error);
        return nil;
    }
    if (!layers[FrotzKeyboardLayerShift]) {
        NSMutableArray *shiftRows = [NSMutableArray array];
        for (FrotzKeyboardRow *row in defaultRows) {
            NSMutableArray *keys = [NSMutableArray array];
            for (FrotzKeyboardKey *key in row.keys)
                [keys addObject: [key upperCasedKey]];
            [shiftRows addObject: [[FrotzKeyboardRow alloc] initWithIndent: row.indent keys: keys]];
        }
        layers[FrotzKeyboardLayerShift] = shiftRows;
    }
    return [[self alloc] initWithID: layoutID name: name layers: layers keyAspect: MAX(0.1, keyAspect) gap: gap];
}

-(instancetype)initWithID:(NSString *)layoutID name:(NSString *)name layers:(NSDictionary *)layers
                keyAspect:(CGFloat)keyAspect gap:(CGFloat)gap {
    if ((self = [super init])) {
        _layoutID = [layoutID copy];
        _name = [name copy];
        _layers = [layers copy];
        _keyAspect = keyAspect;
        _gap = gap;
        for (NSArray<FrotzKeyboardRow *> *rows in [layers objectEnumerator]) {
            _maxRowCount = MAX(_maxRowCount, rows.count);
            for (FrotzKeyboardRow *row in rows)
                _unitsPerRow = MAX(_unitsPerRow, [row units]);
        }
    }
    return self;
}

-(NSUInteger)rowCountForLayer:(NSString *)layer {
    return [_layers[layer] count];
}

@end

#pragma mark - Skin

@implementation FrotzKeyboardSkin {
    NSDictionary *m_keyColors, *m_pressedColors, *m_textColors;
    UIColor *m_keyColor, *m_pressedColor, *m_textColor;
    NSString *m_fontName;
    CGFloat m_fontSize;
}

+(NSArray<NSString *> *)availableSkinIDs {
    NSString *dir = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent: kKeyboardsFolder];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSMutableArray *ids = [NSMutableArray array];
    for (NSString *item in [fm contentsOfDirectoryAtPath: dir error: nil]) {
        NSString *itemDir = [dir stringByAppendingPathComponent: item];
        if ([fm fileExistsAtPath: [itemDir stringByAppendingPathComponent: @"layout.json"]]
            && [fm fileExistsAtPath: [itemDir stringByAppendingPathComponent: @"skin.json"]])
            [ids addObject: item];
    }
    return [ids sortedArrayUsingSelector: @selector(compare:)];
}

+(instancetype)skinWithID:(NSString *)skinID {
    NSDictionary *json = LoadKeyboardJSON(skinID, @"skin.json");
    if (!json)
        return nil;
    NSString *error = nil;
    NSDictionary *key = Optional(json, @"key", [NSDictionary class], &error);
    UIColor *caseColor = DynamicColor(Optional(json, @"case", [NSDictionary class], &error), @"light", @"dark", &error);
    UIColor *keyColor = DynamicColor(key, @"light", @"dark", &error);
    UIColor *textColor = DynamicColor(key, @"textLight", @"textDark", &error);
    if (!caseColor || !keyColor || !textColor)
        Fail(&error, @"case or key colours missing");
    UIColor *pressedColor = DynamicColor(key, @"pressedLight", @"pressedDark", &error);
    NSDictionary *profiles = @{ @"flat": @(FrotzKeyProfileFlat), @"rounded": @(FrotzKeyProfileRounded),
                                @"sculpted": @(FrotzKeyProfileSculpted), @"chiclet": @(FrotzKeyProfileChiclet) };
    NSString *profileName = Optional(json, @"profile", [NSString class], &error) ?: @"rounded";
    if (!profiles[profileName])
        Fail(&error, [NSString stringWithFormat: @"unknown profile \"%@\"", profileName]);
    NSString *name = Optional(json, @"name", [NSString class], &error) ?: skinID;
    NSDictionary *bezel = Optional(json, @"bezel", [NSDictionary class], &error);
    CGFloat sides = OptionalNumber(bezel, @"sides", 4, &error);
    CGFloat top = OptionalNumber(bezel, @"top", 8, &error), bottom = OptionalNumber(bezel, @"bottom", 8, &error);
    if (sides < 0 || top < 0 || bottom < 0)
        Fail(&error, @"a bezel inset is negative");
    CGFloat radius = OptionalNumber(key, @"radius", 6, &error);
    if (radius < 0)
        Fail(&error, @"radius is negative");
    NSNumber *shadow = OptionalBool(key, @"shadow", &error);
    NSString *fontName = Optional(key, @"font", [NSString class], &error) ?: @"system";
    CGFloat fontSize = OptionalNumber(key, @"fontSize", 22, &error);
    if (fontSize <= 0)
        Fail(&error, @"fontSize is zero or less");

    NSMutableDictionary *keyColors = [NSMutableDictionary dictionary], *pressed = [NSMutableDictionary dictionary],
                        *text = [NSMutableDictionary dictionary];
    NSDictionary *groups = Optional(json, @"groups", [NSDictionary class], &error);
    for (NSString *group in groups) {
        NSString *groupError = nil;
        NSDictionary *g = Optional(groups, group, [NSDictionary class], &groupError);
        UIColor *c = DynamicColor(g, @"light", @"dark", &groupError);
        if (c)
            keyColors[group] = c;
        // A pressed modifier lights up like a letter key, as on iOS.
        pressed[group] = DynamicColor(g, @"pressedLight", @"pressedDark", &groupError) ?: keyColor ?: [UIColor clearColor];
        UIColor *t = DynamicColor(g, @"textLight", @"textDark", &groupError);
        if (t)
            text[group] = t;
        if (groupError)
            Fail(&error, [NSString stringWithFormat: @"group \"%@\": %@", group, groupError]);
    }
    if (error) {
        LogMalformed(@"skin.json", skinID, error);
        return nil;
    }

    FrotzKeyboardSkin *skin = [[self alloc] init];
    skin->_skinID = [skinID copy];
    skin->_name = [name copy];
    skin->_profile = [profiles[profileName] integerValue];
    skin->_bezelInsets = UIEdgeInsetsMake(top, sides, bottom, sides);
    skin->_cornerRadius = skin->_profile == FrotzKeyProfileFlat ? 0 : radius;
    skin->_shadow = skin->_profile == FrotzKeyProfileRounded || skin->_profile == FrotzKeyProfileChiclet
                    ? [shadow boolValue] : NO;
    skin->_caseColor = caseColor;
    skin->m_keyColor = keyColor;
    skin->m_textColor = textColor;
    skin->m_pressedColor = pressedColor ?: keyColor;
    skin->m_fontName = fontName;
    skin->m_fontSize = MAX(6, fontSize);
    skin->m_keyColors = keyColors;
    skin->m_pressedColors = pressed;
    skin->m_textColors = text;
    return skin;
}

-(UIColor *)keyColorForGroup:(NSString *)group {
    return m_keyColors[group] ?: m_keyColor;
}

-(UIColor *)pressedColorForGroup:(NSString *)group {
    return m_pressedColors[group] ?: m_pressedColor;
}

-(UIColor *)textColorForGroup:(NSString *)group {
    return m_textColors[group] ?: m_textColor;
}

-(UIFont *)fontForKeyHeight:(CGFloat)keyHeight {
    CGFloat size = round(m_fontSize * keyHeight / kNominalKeyHeight);
    if ([m_fontName isEqualToString: @"system"])
        return [UIFont systemFontOfSize: size];
    if ([m_fontName isEqualToString: @"system-mono"])
        return [UIFont monospacedSystemFontOfSize: size weight: UIFontWeightRegular];
    return [UIFont fontWithName: m_fontName size: size] ?: [UIFont systemFontOfSize: size];
}

@end
