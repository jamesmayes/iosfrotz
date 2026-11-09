/*
 FrotzPostureObserver.h

 This program is free software; you can redistribute it and/or
 modify it under the terms of the GNU General Public License
 as published by the Free Software Foundation; version 2
 of the License.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program; if not, write to the Free Software
 Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

 */

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, FrotzPosture) { FrotzPostureUnknown, FrotzPostureClosed, FrotzPosturePartiallyOpen, FrotzPostureFullyOpen };

@class FrotzPostureObserver;

@protocol FrotzPostureObserverDelegate <NSObject>
-(void)postureObserverDidChange:(FrotzPostureObserver *)observer;
@end

// Where a foldable's hinge is and how far it's open, so the story layout can keep clear of the fold.
// Main thread only, like the view it watches; the delegate is called there too.
@interface FrotzPostureObserver : NSObject
-(instancetype)initWithView:(UIView *)view NS_DESIGNATED_INITIALIZER;
-(instancetype)init NS_UNAVAILABLE;
@property (nonatomic, weak, nullable) id<FrotzPostureObserverDelegate> delegate;
@property (nonatomic, readonly) FrotzPosture posture;
@property (nonatomic, readonly) CGFloat hingeAngleDegrees;   // 0 when unknown
@property (nonatomic, readonly) CGRect foldFrameInView;      // CGRectNull when there is no active fold region
@property (nonatomic, readonly) BOOL isLaptopPosture;        // partially open and the fold wider than tall (hinge horizontal)
@property (nonatomic, readonly, class) BOOL isSupported;     // the running OS and the SDK we built with both have the hinge API
-(void)start;
-(void)stop;
-(void)refresh;                                              // re-reads the fold region; call after layout
@end

NS_ASSUME_NONNULL_END
