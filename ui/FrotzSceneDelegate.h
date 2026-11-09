//
//  FrotzSceneDelegate.h
//  Frotz
//
//  Scene lifecycle delegate. Owns the window and the per-scene setup that
//  previously lived in FrotzAppDelegate.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface FrotzSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nullable, nonatomic, strong) UIWindow *window;
@end

// The window routes touches on the story view, status line and input line to their handleTouch:
// first. A phase that returns NO consumes the touch until it ends: UIKit still delivers it, so the
// touch's lifecycle stays whole, but those views ignore it, in their touch handlers and recognizers,
// and recognizers already tracking it on the routed view are reset.
FOUNDATION_EXPORT BOOL FrotzTouchIsConsumed(UITouch *touch);
FOUNDATION_EXPORT NSSet<UITouch *> *FrotzUnconsumedTouches(NSSet<UITouch *> *touches); // the set itself when none is consumed
FOUNDATION_EXPORT BOOL FrotzViewHasConsumedTouch(UIView *view);  // a consumed touch routed to it or a subview

NS_ASSUME_NONNULL_END
