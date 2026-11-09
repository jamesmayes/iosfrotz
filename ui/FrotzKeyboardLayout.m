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

static id Typed(NSDictionary *dict, NSString *key, Class cls) {
    id value = dict[key];
    return [value isKindOfClass: cls] ? value : nil;
}

static CGFloat NumberOr(NSDictionary *dict, NSString *key, CGFloat fallback) {
    NSNumber *n = Typed(dict, key, [NSNumber class]);
    return n ? [n doubleValue] : fallback;
}

static UIColor *ColorFromHex(id value) {
    if (![value isKindOfClass: [NSString class]])
        return nil;
    NSString *hex = value;
    if ([hex hasPrefix: @"#"])
        hex = [hex substringFromIndex: 1];
    if (hex.length != 6)
        return nil;
    unsigned int rgb = 0;
    NSScanner *scanner = [NSScanner scannerWithString: hex];
    if (![scanner scanHexInt: &rgb] || !scanner.atEnd)
        return nil;
    return [UIColor colorWithRed: ((rgb >> 16) & 0xFF) / 255.0 green: ((rgb >> 8) & 0xFF) / 255.0
                            blue: (rgb & 0xFF) / 255.0 alpha: 1.0];
}

// A light/dark pair from {"light": ..., "dark": ...}; a missing dark uses light.
static UIColor *DynamicColor(NSDictionary *dict, NSString *lightKey, NSString *darkKey) {
    UIColor *light = ColorFromHex(dict[lightKey]);
    if (!light)
        return nil;
    UIColor *dark = ColorFromHex(dict[darkKey]) ?: light;
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
        *error = @"a key is not an object";
        return nil;
    }
    NSDictionary *dict = json;
    NSString *label = Typed(dict, @"label", [NSString class]);
    if (!label) {
        *error = @"a key has no label";
        return nil;
    }
    NSString *actionName = Typed(dict, @"action", [NSString class]) ?: @"text";
    NSNumber *action = [self actionNames][actionName];
    if (!action) {
        *error = [NSString stringWithFormat: @"unknown action \"%@\"", actionName];
        return nil;
    }
    FrotzKeyAction a = [action integerValue];
    NSString *text = Typed(dict, @"text", [NSString class]);
    if (!text)
        text = a == FrotzKeyActionSpace ? @" " : label;
    BOOL repeatsByDefault = (a == FrotzKeyActionBackspace || a == FrotzKeyActionUp || a == FrotzKeyActionDown
                             || a == FrotzKeyActionLeft || a == FrotzKeyActionRight);
    NSNumber *repeats = Typed(dict, @"repeat", [NSNumber class]);
    CGFloat width = NumberOr(dict, @"width", 1);
    if (width <= 0) {
        *error = @"a key has a width of zero or less";
        return nil;
    }
    return [[self alloc] initWithLabel: label text: text action: a width: width
                                 group: Typed(dict, @"group", [NSString class]) ?: @"alpha"
                               repeats: repeats ? [repeats boolValue] : repeatsByDefault
                              sublabel: Typed(dict, @"sublabel", [NSString class])];
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
        *error = @"a layer is not a non-empty array of rows";
        return nil;
    }
    NSMutableArray *rows = [NSMutableArray array];
    for (id rowJSON in json) {
        if (![rowJSON isKindOfClass: [NSDictionary class]] || ![rowJSON[@"keys"] isKindOfClass: [NSArray class]]) {
            *error = @"a row has no keys array";
            return nil;
        }
        NSMutableArray *keys = [NSMutableArray array];
        for (id keyJSON in rowJSON[@"keys"]) {
            FrotzKeyboardKey *key = [FrotzKeyboardKey keyWithJSON: keyJSON error: error];
            if (!key)
                return nil;
            [keys addObject: key];
        }
        [rows addObject: [[FrotzKeyboardRow alloc] initWithIndent: NumberOr(rowJSON, @"indent", 0) keys: keys]];
    }
    return rows;
}

+(instancetype)layoutWithID:(NSString *)layoutID {
    NSDictionary *json = LoadKeyboardJSON(layoutID, @"layout.json");
    if (!json)
        return nil;
    NSDictionary *layersJSON = Typed(json, @"layers", [NSDictionary class]);
    NSString *error = nil;
    NSMutableDictionary *layers = [NSMutableDictionary dictionary];
    for (NSString *name in layersJSON) {
        NSArray *rows = ParseRows(layersJSON[name], &error);
        if (!rows) {
            LogMalformed(@"layout.json", layoutID, [NSString stringWithFormat: @"layer \"%@\": %@", name, error]);
            return nil;
        }
        layers[name] = rows;
    }
    NSArray<FrotzKeyboardRow *> *defaultRows = layers[FrotzKeyboardLayerDefault];
    if (!defaultRows) {
        LogMalformed(@"layout.json", layoutID, @"no default layer");
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
    return [[self alloc] initWithID: layoutID json: json layers: layers];
}

-(instancetype)initWithID:(NSString *)layoutID json:(NSDictionary *)json layers:(NSDictionary *)layers {
    if ((self = [super init])) {
        _layoutID = [layoutID copy];
        _name = [(Typed(json, @"name", [NSString class]) ?: layoutID) copy];
        _layers = [layers copy];
        _keyAspect = MAX(0.1, NumberOr(json, @"keyAspect", 1.0));
        _gap = MAX(0, NumberOr(json, @"gap", 6));
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
    NSDictionary *key = Typed(json, @"key", [NSDictionary class]);
    UIColor *caseColor = DynamicColor(Typed(json, @"case", [NSDictionary class]), @"light", @"dark");
    UIColor *keyColor = DynamicColor(key, @"light", @"dark");
    UIColor *textColor = DynamicColor(key, @"textLight", @"textDark");
    if (!caseColor || !keyColor || !textColor) {
        LogMalformed(@"skin.json", skinID, @"case or key colours missing or not #RRGGBB");
        return nil;
    }
    NSDictionary *profiles = @{ @"flat": @(FrotzKeyProfileFlat), @"rounded": @(FrotzKeyProfileRounded),
                                @"sculpted": @(FrotzKeyProfileSculpted), @"chiclet": @(FrotzKeyProfileChiclet) };
    NSString *profileName = Typed(json, @"profile", [NSString class]) ?: @"rounded";
    if (!profiles[profileName]) {
        LogMalformed(@"skin.json", skinID, [NSString stringWithFormat: @"unknown profile \"%@\"", profileName]);
        return nil;
    }
    FrotzKeyboardSkin *skin = [[self alloc] init];
    skin->_skinID = [skinID copy];
    skin->_name = [(Typed(json, @"name", [NSString class]) ?: skinID) copy];
    skin->_profile = [profiles[profileName] integerValue];
    NSDictionary *bezel = Typed(json, @"bezel", [NSDictionary class]);
    CGFloat sides = NumberOr(bezel, @"sides", 4);
    skin->_bezelInsets = UIEdgeInsetsMake(NumberOr(bezel, @"top", 8), sides, NumberOr(bezel, @"bottom", 8), sides);
    skin->_cornerRadius = skin->_profile == FrotzKeyProfileFlat ? 0 : NumberOr(key, @"radius", 6);
    skin->_shadow = skin->_profile == FrotzKeyProfileRounded || skin->_profile == FrotzKeyProfileChiclet
                    ? [Typed(key, @"shadow", [NSNumber class]) boolValue] : NO;
    skin->_caseColor = caseColor;
    skin->m_keyColor = keyColor;
    skin->m_textColor = textColor;
    skin->m_pressedColor = DynamicColor(key, @"pressedLight", @"pressedDark") ?: keyColor;
    skin->m_fontName = Typed(key, @"font", [NSString class]) ?: @"system";
    skin->m_fontSize = MAX(6, NumberOr(key, @"fontSize", 22));

    NSMutableDictionary *keyColors = [NSMutableDictionary dictionary], *pressed = [NSMutableDictionary dictionary],
                        *text = [NSMutableDictionary dictionary];
    NSDictionary *groups = Typed(json, @"groups", [NSDictionary class]);
    for (NSString *group in groups) {
        NSDictionary *g = Typed(groups, group, [NSDictionary class]);
        UIColor *c = DynamicColor(g, @"light", @"dark");
        if (c)
            keyColors[group] = c;
        // A pressed modifier lights up like a letter key, as on iOS.
        pressed[group] = DynamicColor(g, @"pressedLight", @"pressedDark") ?: keyColor;
        UIColor *t = DynamicColor(g, @"textLight", @"textDark");
        if (t)
            text[group] = t;
    }
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
