//
//  FrotzKeyboardLayout.h
//  Frotz
//
//  Key layouts and skins for the in-app keyboards, loaded from
//  keyboards/<id>/layout.json and skin.json in the app bundle.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, FrotzKeyAction) {
    FrotzKeyActionText, FrotzKeyActionBackspace, FrotzKeyActionReturn, FrotzKeyActionShift,
    FrotzKeyActionCaps, FrotzKeyActionSymbols, FrotzKeyActionLetters, FrotzKeyActionSpace,
    FrotzKeyActionEscape, FrotzKeyActionUp, FrotzKeyActionDown, FrotzKeyActionLeft,
    FrotzKeyActionRight, FrotzKeyActionNone
};

typedef NS_ENUM(NSInteger, FrotzKeyProfile) {
    FrotzKeyProfileFlat, FrotzKeyProfileRounded, FrotzKeyProfileSculpted, FrotzKeyProfileChiclet
};

typedef NS_ENUM(NSInteger, FrotzSublabelPosition) {
    FrotzSublabelPositionTop, FrotzSublabelPositionBottom, FrotzSublabelPositionFront
};

extern NSString *const FrotzKeyboardLayerDefault;
extern NSString *const FrotzKeyboardLayerShift;
extern NSString *const FrotzKeyboardLayerSymbols;

@interface FrotzKeyboardKey : NSObject
@property (nonatomic, readonly, copy) NSString *label;
@property (nonatomic, readonly, copy) NSString *text;
@property (nonatomic, readonly) FrotzKeyAction action;
@property (nonatomic, readonly) CGFloat width;
@property (nonatomic, readonly, copy) NSString *group;
@property (nonatomic, readonly) BOOL repeats;
@property (nonatomic, readonly, copy, nullable) NSString *sublabel;    // a second legend, where the skin's sublabelPosition puts it
@property (nonatomic, readonly, copy, nullable) NSString *shiftLabel;  // the shifted character, top right on the key top
@property (nonatomic, readonly, copy) NSString *accessibilityName;     // "a11y", else the label
@end

@interface FrotzKeyboardRow : NSObject
@property (nonatomic, readonly) CGFloat indent;
@property (nonatomic, readonly, copy) NSArray<FrotzKeyboardKey *> *keys;
@end

@interface FrotzKeyboardLayout : NSObject
+(nullable instancetype)layoutWithID:(NSString *)layoutID;
@property (nonatomic, readonly, copy) NSString *layoutID;
@property (nonatomic, readonly, copy) NSString *name;
@property (nonatomic, readonly, copy) NSDictionary<NSString *, NSArray<FrotzKeyboardRow *> *> *layers;
@property (nonatomic, readonly) CGFloat unitsPerRow;   // over every layer, so keys line up when layers switch
@property (nonatomic, readonly) NSUInteger maxRowCount;
@property (nonatomic, readonly) CGFloat keyAspect;
@property (nonatomic, readonly) CGFloat gap;
-(NSUInteger)rowCountForLayer:(NSString *)layer;
@end

@interface FrotzKeyboardSkin : NSObject
+(nullable instancetype)skinWithID:(NSString *)skinID;
+(NSArray<NSString *> *)availableSkinIDs;
@property (nonatomic, readonly, copy) NSString *skinID;
@property (nonatomic, readonly, copy) NSString *name;
@property (nonatomic, readonly) FrotzKeyProfile profile;
@property (nonatomic, readonly) UIEdgeInsets bezelInsets;
@property (nonatomic, readonly) CGFloat cornerRadius;
@property (nonatomic, readonly) BOOL shadow;
@property (nonatomic, readonly, strong) UIColor *caseColor;
@property (nonatomic, readonly) FrotzSublabelPosition sublabelPosition; // front: on a sculpted key's front face
@property (nonatomic, readonly) BOOL upperCaseLegends; // "legendCase": "upper" draws caps on text keys that type lower case
@property (nonatomic, readonly) BOOL blankCaps; // the legends are printed off the key, so only sublabels are drawn
// "capInset" with top sublabels: a smaller cap sits low in the key's area, and the top legends go
// on the case above it in "case" textLight/textDark. Points, or under 1 a fraction of the key's height.
@property (nonatomic, readonly) CGFloat capInset;
@property (nonatomic, readonly, strong) UIColor *caseTextColor;
-(UIColor *)keyColorForGroup:(NSString *)group;
-(UIColor *)pressedColorForGroup:(NSString *)group;
-(UIColor *)textColorForGroup:(NSString *)group;
-(UIFont *)fontForKeyHeight:(CGFloat)keyHeight;
@end

NS_ASSUME_NONNULL_END
