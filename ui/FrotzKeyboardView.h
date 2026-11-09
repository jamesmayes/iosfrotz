//
//  FrotzKeyboardView.h
//  Frotz
//
//  An in-app keyboard drawn from a FrotzKeyboardLayout and FrotzKeyboardSkin.
//  It only reports keys; the story controller feeds them to the input line.
//

#import <UIKit/UIKit.h>
#import "FrotzKeyboardLayout.h"
#import "FrotzKeyboardTypes.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, FrotzKeyboardShiftState) {
    FrotzKeyboardShiftOff, FrotzKeyboardShiftOneShot, FrotzKeyboardShiftCapsLock
};

@class FrotzKeyboardView;

@protocol FrotzKeyboardViewDelegate <NSObject>
-(void)keyboardView:(FrotzKeyboardView *)keyboardView didTypeText:(NSString *)text;
-(void)keyboardViewDidBackspace:(FrotzKeyboardView *)keyboardView;
-(void)keyboardViewDidReturn:(FrotzKeyboardView *)keyboardView;
-(void)keyboardView:(FrotzKeyboardView *)keyboardView didPressSpecialKey:(FrotzKeyboardSpecialKey)key;
@end

@interface FrotzKeyboardView : UIView
-(instancetype)initWithLayout:(FrotzKeyboardLayout *)layout skin:(FrotzKeyboardSkin *)skin NS_DESIGNATED_INITIALIZER;
-(instancetype)initWithFrame:(CGRect)frame NS_UNAVAILABLE;
-(instancetype)initWithCoder:(NSCoder *)coder NS_UNAVAILABLE;
@property (nonatomic, weak, nullable) id<FrotzKeyboardViewDelegate> delegate;
@property (nonatomic, readonly, strong) FrotzKeyboardLayout *layout;
@property (nonatomic, readonly, strong) FrotzKeyboardSkin *skin;
/// Bezel plus the rows at the key height this width gives; excludes the safe area.
-(CGFloat)preferredHeightForWidth:(CGFloat)width;
/// Case colour only above the keys (an iPhone Duo's fold band sits there). Default 0.
@property (nonatomic) CGFloat topInset;
/// Keys grow to fill the view's height (up to 96 pt) rather than keep their natural height.
@property (nonatomic) BOOL fillsHeight;
@property (nonatomic, copy) NSString *keyLayer;   // FrotzKeyboardLayerDefault / Shift / Symbols ("layer" is UIView's)
@property (nonatomic) FrotzKeyboardShiftState shiftState;
#if DEBUG
/// Presses and releases the key with this label in the current layer through the touch path. NO if there is none.
-(BOOL)tapKeyWithLabel:(NSString *)label;
/// The key's centre in the keyboard's coordinates; NAN if this layer has no such key.
-(CGPoint)centerOfKeyWithLabel:(NSString *)label;
/// The label of the key a touch at this point (keyboard coordinates) would press.
-(nullable NSString *)labelOfKeyAtPoint:(CGPoint)pt;
#endif
@end

NS_ASSUME_NONNULL_END
