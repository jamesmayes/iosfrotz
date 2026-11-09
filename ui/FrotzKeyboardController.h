/*
 FrotzKeyboardController.h

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
#import "FrotzPostureObserver.h"
#import "FrotzKeyboardView.h"

NS_ASSUME_NONNULL_BEGIN

@class StoryMainViewController;

// Owns the in-app keyboard and decides where it sits: below the fold on a half-open iPhone Duo,
// docked at the bottom everywhere else. The story controller learns only the region it covers.
@interface FrotzKeyboardController : NSObject <FrotzPostureObserverDelegate, FrotzKeyboardViewDelegate>
-(instancetype)initWithStoryController:(StoryMainViewController *)smvc postureObserver:(FrotzPostureObserver *)observer NS_DESIGNATED_INITIALIZER;
-(instancetype)init NS_UNAVAILABLE;
@property (nonatomic, copy, nullable) NSString *skinID;        // nil = system keyboard
@property (nonatomic, readonly) BOOL isInAppKeyboardActive;
@property (nonatomic, readonly) BOOL isShowing;                  // in-app keyboard currently visible
@property (nonatomic, readonly, nullable) FrotzKeyboardView *keyboardView;
-(void)showAnimated:(BOOL)animated;
-(void)hideAnimated:(BOOL)animated;
-(void)toggleAnimated:(BOOL)animated;
-(void)layoutIfNeeded;                                           // after the story view's layout; re-docks only when the target frame changed
-(void)storyPageDidBecomeVisible;                                // the notes page hands the keyboard back
-(void)notesPageDidBecomeVisible;                                // the notes text view uses the system keyboard meanwhile
@end

NS_ASSUME_NONNULL_END
