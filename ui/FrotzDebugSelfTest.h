/*
 FrotzDebugSelfTest.h

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

// DEBUG builds only; empty otherwise. The environment it reads is listed in FrotzDebugSelfTest.m.

#if DEBUG
#import <UIKit/UIKit.h>
#import "FrotzPostureObserver.h"

@class StoryMainViewController, StoryBrowser, FrotzKeyboardView, FrotzKeyboardKey;

NS_ASSUME_NONNULL_BEGIN

@interface FrotzDebugSelfTest : NSObject
+(void)installInto:(StoryMainViewController *)controller;          // from viewDidAppear: the override skin, then any self-test asked for
+(BOOL)overridesKeyboardStyle;                                    // FROTZ_INAPP_KEYBOARD is set, so the pref mustn't replace it
+(void)openStoryAtLaunchWithBrowser:(StoryBrowser *)browser;      // FROTZ_SELFTEST_STORY
+(void)window:(UIWindow *)window willSendEvent:(UIEvent *)event;  // "kbtouch" lines for the keyboard's touches
+(BOOL)fakeBounds:(CGSize *)size;                                 // FROTZ_FAKE_BOUNDS
+(void)postureDidChange:(FrotzPostureObserver *)observer;
// FROTZ_FAKE_POSTURE: YES and the fake state (any pointer may be NULL) when it's set.
+(BOOL)fakePosture:(nullable FrotzPosture *)posture angle:(nullable CGFloat *)angle fold:(nullable CGRect *)fold inView:(nullable UIView *)view;
+(void)keyboardView:(FrotzKeyboardView *)keyboard willPerformKey:(FrotzKeyboardKey *)key;
+(void)keyboardView:(FrotzKeyboardView *)keyboard willAnnounce:(NSString *)announcement withLayoutChange:(BOOL)layoutChange;
+(void)notesPageDidChange:(BOOL)notesVisible via:(NSString *)site;
@end

NS_ASSUME_NONNULL_END
#endif
