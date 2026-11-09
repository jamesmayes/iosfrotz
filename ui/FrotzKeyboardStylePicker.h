/*
 FrotzKeyboardStylePicker.h

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
#import "FrotzSettings.h"

NS_ASSUME_NONNULL_BEGIN

// The system keyboard, then every bundled skin with a small picture of it, so the
// skins can be compared before choosing one.
@interface FrotzKeyboardStylePicker : UITableViewController
-(instancetype)initWithStoryDelegate:(id<FrotzSettingsStoryDelegate>)storyDelegate NS_DESIGNATED_INITIALIZER;
-(instancetype)initWithStyle:(UITableViewStyle)style NS_UNAVAILABLE;
-(instancetype)initWithNibName:(nullable NSString *)nibNameOrNil bundle:(nullable NSBundle *)nibBundleOrNil NS_UNAVAILABLE;
-(instancetype)initWithCoder:(NSCoder *)coder NS_UNAVAILABLE;
@property (nonatomic, weak, nullable) id<FrotzSettingsStoryDelegate> storyDelegate;
+(NSString *)displayNameForStyle:(nullable NSString *)skinID;   // the settings row's detail text
@end

NS_ASSUME_NONNULL_END
