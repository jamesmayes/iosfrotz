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
/// The same for the full or the compact rows, whichever is showing now.
-(CGFloat)preferredHeightForWidth:(CGFloat)width compact:(BOOL)compact;
/// Case colour only above the keys (an iPhone Duo's fold band sits there). Default 0.
@property (nonatomic) CGFloat topInset;
/// Keys grow to fill the view's height (up to 96 pt) rather than keep their natural height.
@property (nonatomic) BOOL fillsHeight;
/// The layout's compact rows at no more than 40 pt a key, for a Flow layout. Default NO.
@property (nonatomic) BOOL compact;
@property (nonatomic, copy) NSString *keyLayer;   // FrotzKeyboardLayerDefault / Shift / Symbols ("layer" is UIView's)
@property (nonatomic) FrotzKeyboardShiftState shiftState;
@end

NS_ASSUME_NONNULL_END
