/*
 FrotzKeyboardStylePicker.m

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

#import "FrotzKeyboardStylePicker.h"
#import "FrotzKeyboardView.h"

static const CGFloat kPreviewRowHeight = 120.0;
static const CGFloat kPreviewNameHeight = 22.0;
static const CGFloat kPreviewMargin = 6.0;

// A skin's name over a scaled-down keyboard drawn at the row's width.
@interface FrotzKeyboardPreviewCell : UITableViewCell
{
    UILabel *m_nameLabel;
    FrotzKeyboardView *m_preview;
}
-(void)setLayout:(FrotzKeyboardLayout *)layout skin:(FrotzKeyboardSkin *)skin;
@end

@implementation FrotzKeyboardPreviewCell

-(instancetype)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)reuseIdentifier {
    if ((self = [super initWithStyle: style reuseIdentifier: reuseIdentifier])) {
        m_nameLabel = [[UILabel alloc] initWithFrame: CGRectZero];
        m_nameLabel.font = [UIFont preferredFontForTextStyle: UIFontTextStyleBody];
        [self.contentView addSubview: m_nameLabel];
        self.contentView.clipsToBounds = YES;
    }
    return self;
}

-(void)setLayout:(FrotzKeyboardLayout *)layout skin:(FrotzKeyboardSkin *)skin {
    m_nameLabel.text = skin.name;
    self.accessibilityLabel = skin.name;
    if (m_preview.skin == skin && m_preview.layout == layout)
        return;
    [m_preview removeFromSuperview];
    m_preview = [[FrotzKeyboardView alloc] initWithLayout: layout skin: skin];
    m_preview.userInteractionEnabled = NO; // a picture to compare by; the row takes the tap
    m_preview.accessibilityElementsHidden = YES;
    [self.contentView addSubview: m_preview];
    [self setNeedsLayout];
}

-(void)layoutSubviews {
    [super layoutSubviews];
    CGRect bounds = self.contentView.bounds;
    CGFloat left = self.contentView.layoutMargins.left, width = bounds.size.width - left - self.contentView.layoutMargins.right;
    m_nameLabel.frame = CGRectMake(left, kPreviewMargin, width, kPreviewNameHeight);
    if (!m_preview || width <= 0)
        return;
    // Lay the keys out at the full row width, then shrink the whole keyboard to the space under the name.
    CGFloat height = [m_preview preferredHeightForWidth: width];
    CGFloat top = kPreviewMargin + kPreviewNameHeight + kPreviewMargin;
    CGFloat avail = bounds.size.height - top - kPreviewMargin;
    CGFloat scale = height > avail ? avail / height : 1.0;
    m_preview.transform = CGAffineTransformIdentity;
    m_preview.bounds = CGRectMake(0, 0, width, height);
    m_preview.center = CGPointMake(left + width / 2, top + height * scale / 2);
    m_preview.transform = CGAffineTransformMakeScale(scale, scale);
}

@end

@implementation FrotzKeyboardStylePicker
{
    NSArray<FrotzKeyboardSkin *> *m_skins;
    NSArray<FrotzKeyboardLayout *> *m_layouts;
}

+(NSString *)displayNameForStyle:(NSString *)skinID {
    FrotzKeyboardSkin *skin = skinID.length ? [FrotzKeyboardSkin skinWithID: skinID] : nil;
    return skin ? skin.name : NSLocalizedString(@"System", @"");
}

-(instancetype)initWithStoryDelegate:(id<FrotzSettingsStoryDelegate>)storyDelegate {
    if ((self = [super initWithStyle: UITableViewStyleInsetGrouped])) {
        _storyDelegate = storyDelegate;
        self.title = NSLocalizedString(@"Keyboard Style", @"");
    }
    return self;
}

-(void)loadSkins {
    NSMutableArray *skins = [NSMutableArray array];
    for (NSString *skinID in [FrotzKeyboardSkin availableSkinIDs]) {
        FrotzKeyboardSkin *skin = [FrotzKeyboardSkin skinWithID: skinID];
        if (skin && [FrotzKeyboardLayout layoutWithID: skinID]) // a broken skin isn't offered
            [skins addObject: skin];
    }
    [skins sortUsingComparator: ^NSComparisonResult(FrotzKeyboardSkin *a, FrotzKeyboardSkin *b) {
        return [a.name localizedStandardCompare: b.name];
    }];
    NSMutableArray *layouts = [NSMutableArray array];
    for (FrotzKeyboardSkin *skin in skins)
        [layouts addObject: [FrotzKeyboardLayout layoutWithID: skin.skinID]];
    m_skins = skins;
    m_layouts = layouts;
}

-(void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear: animated];
    if (!m_skins)
        [self loadSkins];
    [self.tableView reloadData];
}

-(NSString *)styleForRow:(NSInteger)row {
    return row == 0 ? nil : m_skins[row - 1].skinID;
}

#pragma mark - UITableView

-(NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    return 1 + m_skins.count;
}

-(CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)indexPath {
    return indexPath.row == 0 ? UITableViewAutomaticDimension : kPreviewRowHeight;
}

-(UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    UITableViewCell *cell;
    if (indexPath.row == 0) {
        cell = [tableView dequeueReusableCellWithIdentifier: @"system"]
            ?: [[UITableViewCell alloc] initWithStyle: UITableViewCellStyleDefault reuseIdentifier: @"system"];
        cell.textLabel.text = NSLocalizedString(@"Classic iOS keyboard (system)", @"");
    } else {
        FrotzKeyboardPreviewCell *preview = [tableView dequeueReusableCellWithIdentifier: @"preview"]
            ?: [[FrotzKeyboardPreviewCell alloc] initWithStyle: UITableViewCellStyleDefault reuseIdentifier: @"preview"];
        [preview setLayout: m_layouts[indexPath.row - 1] skin: m_skins[indexPath.row - 1]];
        cell = preview;
    }
    NSString *current = [_storyDelegate keyboardStyle], *style = [self styleForRow: indexPath.row];
    BOOL selected = style ? [style isEqualToString: current] : current.length == 0;
    cell.accessoryType = selected ? UITableViewCellAccessoryCheckmark : UITableViewCellAccessoryNone;
    return cell;
}

-(void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath: indexPath animated: YES];
    [_storyDelegate setKeyboardStyle: [self styleForRow: indexPath.row]];
    for (NSIndexPath *visible in tableView.indexPathsForVisibleRows)
        [tableView cellForRowAtIndexPath: visible].accessoryType = (visible.row == indexPath.row)
            ? UITableViewCellAccessoryCheckmark : UITableViewCellAccessoryNone;
}

#if DEBUG
-(void)selectRow:(NSInteger)row {
    NSIndexPath *indexPath = [NSIndexPath indexPathForRow: row inSection: 0];
    if (row >= 0 && row < [self tableView: self.tableView numberOfRowsInSection: 0])
        [self tableView: self.tableView didSelectRowAtIndexPath: indexPath];
}
#endif

@end
