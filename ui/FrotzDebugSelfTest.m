/*
 FrotzDebugSelfTest.m

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

// DEBUG builds only. The in-app keyboard's self-tests and logs, and the overrides that let a
// simulator that can't be tapped, folded or rotated from a script reach every layout. The
// production files call in here from one #if DEBUG line at each place it needs.
//
// Environment, read at launch:
//   FROTZ_FAKE_POSTURE=closed|partial|open     stands in for the hinge; wins over the real API
//   FROTZ_FAKE_FOLD_Y=<points>                 centre of the fake fold from the top of the view (default: half
//                                              the view height). The fake fold is 24pt tall and full width;
//                                              none when closed.
//   FROTZ_INAPP_KEYBOARD=<skin id>|system      overrides the keyboardStyle pref, once, at the first appearance
//   FROTZ_FAKE_BOUNDS=<w>x<h>                  the size the docked keyboard's height cap is worked out from
//                                              (a landscape phone, on a simulator that can't be rotated)
//   FROTZ_SELFTEST_STORY=<story file>          opened at launch as a file handed to Frotz would be
//   FROTZ_INAPP_KEYBOARD_SELFTEST=1            runs the keyboard script for the FROTZ_INAPP_KEYBOARD skin
//   FROTZ_SELFTEST_SCRIPT=<step>|<step>|...    that script instead (steps under -runKeyboardSelfTest)
//   FROTZ_SELFTEST_TO_CLASSIC=1                ends a Flow run by switching to the Classic split
//   FROTZ_SETTINGS_SELFTEST=1                  walks Settings > Keyboard Style and picks
//   FROTZ_SETTINGS_SELFTEST_ROW=<n>            row n (default 1, the first skin; 0 is the system keyboard)
//
// Log prefixes: kbselftest, kbsettings, kbskin, kbhold, kboverlap, kbtouch, kbpage, kba11y, posture=.

#if DEBUG

#import "FrotzDebugSelfTest.h"
#import "StoryMainViewController.h"
#import "StoryBrowser.h"
#import "StoryInputLine.h"
#import "StoryView.h"
#import "InputHelper.h"
#import "CompletionLabel.h"
#import "NotesViewController.h"
#import "FrotzInfo.h"
#import "FrotzSettings.h"
#import "FrotzKeyboardController.h"
#import "FrotzKeyboardLayout.h"
#import "FrotzKeyboardStylePicker.h"
#import "FrotzKeyboardView.h"

NS_ASSUME_NONNULL_BEGIN

#pragma mark - Private pieces the tests reach

// Declared in FrotzKeyboardView.m; only what the tests read.
@interface FrotzKeyView : UIView
@property (nonatomic, strong) FrotzKeyboardKey *key;
@property (nonatomic) BOOL pressed;
@property (nonatomic, weak) FrotzKeyView *joinedKey;
@end

@interface FrotzKeyTouch : NSObject
@property (nonatomic, strong) FrotzKeyView *keyView;
@property (nonatomic, strong) FrotzKeyboardKey *key;
@property (nonatomic, copy) NSString *layer;
@end

static const CGFloat kReleaseSlop = 16; // FrotzKeyboardView.m's

@interface FrotzKeyboardView (FrotzKeyboardInternals)
-(FrotzKeyTouch *)keyTouchDown:(FrotzKeyView *)keyView touch:(nullable UITouch *)touch;
-(void)keyTouchUp:(FrotzKeyTouch *)press touch:(nullable UITouch *)touch inside:(BOOL)inside;
-(void)repeatOnce;
-(void)releaseAllKeys;
-(nullable FrotzKeyView *)keyViewWithLabel:(NSString *)label;
-(nullable FrotzKeyView *)keyViewAtPoint:(CGPoint)pt;
-(CGRect)hitRectForKey:(FrotzKeyView *)keyView;
-(BOOL)point:(CGPoint)pt isOnKey:(FrotzKeyView *)keyView;
-(BOOL)touch:(UITouch *)touch isOnKey:(FrotzKeyView *)keyView;
@end

@interface RichTextView (FrotzFoldInternals)
@property (nonatomic, readonly) CGFloat foldSplitY;      // content coordinates, for the current scroll position
@property (nonatomic, readonly) CGFloat foldLowerShift;
-(CGPoint)textPointForPoint:(CGPoint)pt;
@end

@interface StoryMainViewController (FrotzInternals)
-(void)applyFoldExclusion;
@end

@interface FrotzSettingsController (FrotzInternals)
-(NSIndexPath *)keyboardStyleIndexPath;
@end

// What the keyboard did while a hold or overlap test was watching; nil otherwise.
static NSMutableArray<NSString *> *sHeldActions;

#pragma mark - Keyboard view

@implementation FrotzKeyboardView (FrotzDebugSelfTest)

-(NSMapTable<UITouch *, FrotzKeyTouch *> *)selfTestTouchKeys { return [self valueForKey: @"m_touchKeys"]; }
-(NSArray<FrotzKeyView *> *)selfTestKeyViews { return [self valueForKey: @"m_keyViews"]; }
-(nullable NSTimer *)selfTestRepeatTimer { return [self valueForKey: @"m_repeatTimer"]; }
-(nullable FrotzKeyTouch *)selfTestRepeatPress { return [self valueForKey: @"m_repeatPress"]; }

-(CGPoint)centerOfKeyWithLabel:(NSString *)label {
    FrotzKeyView *kv = [self keyViewWithLabel: label];
    return kv ? CGPointMake(CGRectGetMidX(kv.frame), CGRectGetMidY(kv.frame)) : CGPointMake(NAN, NAN);
}

-(nullable NSString *)labelOfKeyAtPoint:(CGPoint)pt {
    return [self keyViewAtPoint: pt].key.label;
}

-(CGFloat)lowestKeyHitY {
    CGFloat y = 0;
    for (FrotzKeyView *kv in [self selfTestKeyViews])
        y = MAX(y, CGRectGetMaxY([self hitRectForKey: kv]));
    return y;
}

-(BOOL)holdKeyWithLabel:(NSString *)label forSeconds:(NSTimeInterval)seconds {
    FrotzKeyView *kv = [self keyViewWithLabel: label];
    if (!kv)
        return NO;
    // A stand-in for a finger: it owns the press, and so the repeat, until it lets go.
    UITouch *touch = [[UITouch alloc] init];
    sHeldActions = [NSMutableArray array];
    [self keyTouchDown: kv touch: touch];
    __weak FrotzKeyboardView *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf releaseHeldTouch: touch label: label];
    });
    return YES;
}

-(void)releaseHeldTouch:(UITouch *)touch label:(NSString *)label {
    FrotzKeyTouch *press = [[self selfTestTouchKeys] objectForKey: touch];
    [[self selfTestTouchKeys] removeObjectForKey: touch];
    if (press)
        [self keyTouchUp: press touch: touch inside: YES];
    NSCountedSet *counts = [[NSCountedSet alloc] initWithArray: sHeldActions ?: @[]];
    NSMutableArray *parts = [NSMutableArray array];
    for (NSString *action in counts)
        [parts addObject: [NSString stringWithFormat: @"%@ x%lu", action, (unsigned long)[counts countForObject: action]]];
    NSLog(@"kbhold %@ released%@: %@; layer=%@ shift=%d", label, press ? @"" : @" (already let go)",
          [parts componentsJoinedByString: @", "], self.keyLayer, (int)self.shiftState);
    sHeldActions = nil;
}

-(nullable FrotzKeyView *)keyViewWithAction:(FrotzKeyAction)action {
    for (FrotzKeyView *kv in [self selfTestKeyViews])
        if (kv.key.action == action)
            return kv;
    return nil;
}

-(BOOL)tapKeyWithLabel:(NSString *)label {
    FrotzKeyView *kv = [self keyViewWithLabel: label];
    if (!kv)
        return NO;
    FrotzKeyTouch *press = [self keyTouchDown: kv touch: nil];
    [self keyTouchUp: press touch: nil inside: YES];
    return YES;
}

// A finger's press and release on the key with this label in the shown layer, for the overlap test.
-(nullable FrotzKeyTouch *)finger:(UITouch *)touch downOn:(NSString *)label {
    FrotzKeyView *kv = [self keyViewWithLabel: label];
    if (!kv) {
        NSLog(@"kboverlap no key \"%@\" in layer %@", label, self.keyLayer);
        return nil;
    }
    return [self keyTouchDown: kv touch: touch];
}

-(void)fingerUp:(UITouch *)touch {
    FrotzKeyTouch *press = [[self selfTestTouchKeys] objectForKey: touch];
    [[self selfTestTouchKeys] removeObjectForKey: touch];
    if (press)
        [self keyTouchUp: press touch: touch inside: YES];
}

-(void)overlapCheck:(NSString *)name ok:(BOOL)ok detail:(NSString *)detail {
    NSLog(@"kboverlap %@ %@: %@; actions=%@", name, ok ? @"PASS" : @"FAIL", detail, [sHeldActions componentsJoinedByString: @","]);
    [sHeldActions removeAllObjects];
}

// Two stand-in fingers on overlapping presses (a repeat while Shift is tapped, a layer rebuild under a
// held key); logs "kboverlap <case> PASS|FAIL". repeatLabel is a repeating key on the shift layer, or empty.
-(void)runOverlapSelfTestWithShift:(NSString *)shift repeatKey:(NSString *)repeatLabel letter:(NSString *)letter backspace:(NSString *)backspace {
    // Two stand-in fingers driven through the real press records, with the repeat timer's tick
    // called directly, so overlaps that the one-key-at-a-time script can't make happen in order.
    UITouch *a = [[UITouch alloc] init], *b = [[UITouch alloc] init];
    NSString *upper = [letter uppercaseString];
    NSMapTable<UITouch *, FrotzKeyTouch *> *touchKeys = [self selfTestTouchKeys];
    [self releaseAllKeys];
    self.shiftState = FrotzKeyboardShiftOff;
    sHeldActions = [NSMutableArray array];

    if (repeatLabel.length) {
        // 1a. Shift, hold a shifted repeating key (it uses the shift up), Shift again with another
        // finger mid-repeat: the repeats replay the held key and leave the new shift alone.
        [self tapKeyWithLabel: shift];
        FrotzKeyTouch *hold = [self finger: a downOn: repeatLabel];
        [self repeatOnce]; [self repeatOnce];
        [self finger: b downOn: shift]; [self fingerUp: b];
        [self repeatOnce]; [self repeatOnce]; [self repeatOnce];
        FrotzKeyboardShiftState during = self.shiftState;
        [self fingerUp: a];
        [self overlapCheck: @"1a-repeat-keeps-new-shift" ok: hold && during == FrotzKeyboardShiftOneShot && self.shiftState == FrotzKeyboardShiftOneShot
                    detail: [NSString stringWithFormat: @"held %@ from layer %@; shift during repeat=%d after release=%d layer=%@",
                             hold.key.accessibilityName, hold.layer, (int)during, (int)self.shiftState, self.keyLayer]];
        [self tapKeyWithLabel: upper];
        NSString *typed = sHeldActions.lastObject;
        [self overlapCheck: @"1a-next-letter-shifted" ok: [typed isEqualToString: upper] && self.shiftState == FrotzKeyboardShiftOff
                    detail: [NSString stringWithFormat: @"typed %@ then shift=%d", typed, (int)self.shiftState]];

        // 1b. The same hold, and Shift double-tapped by the other finger mid-repeat reaches caps lock.
        [self tapKeyWithLabel: shift];
        [self finger: a downOn: repeatLabel];
        [self repeatOnce];
        [self finger: b downOn: shift]; [self fingerUp: b];
        [self repeatOnce];
        [self finger: b downOn: shift]; [self fingerUp: b];
        [self repeatOnce]; [self repeatOnce];
        during = self.shiftState;
        [self fingerUp: a];
        [self overlapCheck: @"1b-double-tap-reaches-caps" ok: during == FrotzKeyboardShiftCapsLock && self.shiftState == FrotzKeyboardShiftCapsLock
                    detail: [NSString stringWithFormat: @"shift during repeat=%d after release=%d layer=%@", (int)during, (int)self.shiftState, self.keyLayer]];
        [self tapKeyWithLabel: upper];
        typed = sHeldActions.lastObject;
        [self overlapCheck: @"1b-caps-types-upper" ok: [typed isEqualToString: upper] && self.shiftState == FrotzKeyboardShiftCapsLock
                    detail: [NSString stringWithFormat: @"typed %@ then shift=%d", typed, (int)self.shiftState]];
        self.shiftState = FrotzKeyboardShiftOff;
    }

    // 2a. Shift, hold a letter (its layer change waits for it), hold backspace with another finger,
    // let the letter go: the layer is rebuilt and backspace keeps its press, mapping and repeat.
    [self tapKeyWithLabel: shift];
    [self finger: a downOn: upper];
    FrotzKeyTouch *bs = [self finger: b downOn: backspace];
    [self repeatOnce];
    NSString *pendingBefore = [self valueForKey: @"m_pendingLayer"];
    [self fingerUp: a];
    BOOL kept = bs && [self selfTestRepeatTimer].valid && [self selfTestRepeatPress] == bs && [touchKeys objectForKey: b] == bs
        && [[self selfTestKeyViews] containsObject: bs.keyView] && bs.keyView.pressed;
    [self overlapCheck: @"2a-rebuild-keeps-other-finger" ok: kept && [self.keyLayer isEqualToString: FrotzKeyboardLayerDefault]
                detail: [NSString stringWithFormat: @"pending before release=%@ layer now=%@ timer=%d owner=%d mapped=%d onNewView=%d lit=%d",
                         pendingBefore, self.keyLayer, [self selfTestRepeatTimer].valid, [self selfTestRepeatPress] == bs, [touchKeys objectForKey: b] == bs,
                         [[self selfTestKeyViews] containsObject: bs.keyView], bs.keyView.pressed]];
    [self repeatOnce];
    [self fingerUp: b];
    [self overlapCheck: @"2a-repeat-then-release" ok: ![self selfTestRepeatTimer] && ![self selfTestRepeatPress] && !bs.keyView.pressed
                detail: [NSString stringWithFormat: @"timer=%d lit=%d", [self selfTestRepeatTimer] != nil, bs.keyView.pressed]];

    // 2b. Hold backspace, tap Shift with another finger: the layer changes at once and backspace
    // still repeats on the new layer's key.
    bs = [self finger: a downOn: backspace];
    [self finger: b downOn: shift]; [self fingerUp: b];
    kept = bs && [self selfTestRepeatTimer].valid && [self selfTestRepeatPress] == bs && [[self selfTestKeyViews] containsObject: bs.keyView] && bs.keyView.pressed;
    [self repeatOnce];
    [self overlapCheck: @"2b-layer-change-keeps-held-key" ok: kept && [self.keyLayer isEqualToString: FrotzKeyboardLayerShift]
                detail: [NSString stringWithFormat: @"layer now=%@ timer=%d owner=%d onNewView=%d lit=%d", self.keyLayer,
                         [self selfTestRepeatTimer].valid, [self selfTestRepeatPress] == bs, [[self selfTestKeyViews] containsObject: bs.keyView], bs.keyView.pressed]];
    [self fingerUp: a];

    [self releaseAllKeys];
    self.shiftState = FrotzKeyboardShiftOff;

    // 3. A joined key (the IBM's tall Return): a press on either half is still on the key at the
    // far end of the other half, past the release slop of its own half.
    [self layoutIfNeeded]; // the keys were rebuilt above; join them
    for (FrotzKeyView *kv in [self selfTestKeyViews]) {
        FrotzKeyView *other = kv.joinedKey;
        if (!other || CGRectGetMinY(other.frame) < CGRectGetMinY(kv.frame))
            continue; // each pair once, from its upper half
        CGPoint farLower = CGPointMake(CGRectGetMidX(other.frame), CGRectGetMaxY(other.frame) - 2);
        CGPoint farUpper = CGPointMake(CGRectGetMidX(kv.frame), CGRectGetMinY(kv.frame) + 2);
        CGPoint outside = CGPointMake(CGRectGetMaxX(other.frame) + kReleaseSlop + 4, farLower.y);
        BOOL ok = [self point: farLower isOnKey: kv] && [self point: farUpper isOnKey: other] && ![self point: outside isOnKey: kv];
        [self overlapCheck: @"3-joined-key-one-region" ok: ok
                    detail: [NSString stringWithFormat: @"%@ upper %@ lower %@: upper press at %@ on=%d, lower press at %@ on=%d, %@ beside on=%d",
                             kv.key.label, NSStringFromCGRect(kv.frame), NSStringFromCGRect(other.frame),
                             NSStringFromCGPoint(farLower), [self point: farLower isOnKey: kv], NSStringFromCGPoint(farUpper),
                             [self point: farUpper isOnKey: other], NSStringFromCGPoint(outside), [self point: outside isOnKey: kv]]];
    }

    // 4. Hold Return and backspace, tap 123 (Classic): the symbols rows differ, so each held key
    // must move to its own key there, not to whatever sits in its old place.
    FrotzKeyView *returnView = [self keyViewWithAction: FrotzKeyActionReturn], *symbolsView = [self keyViewWithAction: FrotzKeyActionSymbols];
    FrotzKeyboardLayout *rows = [self valueForKey: @"m_rows"];
    if (returnView && symbolsView && [self keyViewWithLabel: backspace] && rows.layers[FrotzKeyboardLayerSymbols]) {
        FrotzKeyTouch *ret = [self finger: a downOn: returnView.key.label];
        bs = [self finger: b downOn: backspace];
        [self tapKeyWithLabel: symbolsView.key.label];
        [self layoutIfNeeded];
        NSArray<FrotzKeyView *> *keyViews = [self selfTestKeyViews];
        BOOL retOK = ret.keyView.key.action == FrotzKeyActionReturn && [keyViews containsObject: ret.keyView] && ret.keyView.pressed;
        BOOL bsOK = bs.keyView.key.action == FrotzKeyActionBackspace && [keyViews containsObject: bs.keyView] && bs.keyView.pressed
            && [self selfTestRepeatPress] == bs;
        [self overlapCheck: @"4-symbols-remaps-held-keys" ok: [self.keyLayer isEqualToString: FrotzKeyboardLayerSymbols] && retOK && bsOK
                    detail: [NSString stringWithFormat: @"layer=%@ return on \"%@\" onNewView=%d lit=%d; backspace on \"%@\" onNewView=%d lit=%d owner=%d",
                             self.keyLayer, ret.keyView.key.label, [keyViews containsObject: ret.keyView], ret.keyView.pressed,
                             bs.keyView.key.label, [keyViews containsObject: bs.keyView], bs.keyView.pressed, [self selfTestRepeatPress] == bs]];
        [self repeatOnce];
        [self fingerUp: a];
        [self fingerUp: b];
        // The repeat sends backspace, Return's release sends return.
        NSString *sent = [sHeldActions componentsJoinedByString: @","];
        NSString *expected = [NSString stringWithFormat: @"%@,%@", [bs.key.accessibilityName lowercaseString], [ret.key.accessibilityName lowercaseString]];
        [self overlapCheck: @"4-held-keys-act-as-pressed" ok: [sent isEqualToString: expected] && !ret.keyView.pressed && !bs.keyView.pressed
                    detail: [NSString stringWithFormat: @"expected %@, lit after release=%d,%d", expected, ret.keyView.pressed, bs.keyView.pressed]];
        [self tapKeyWithLabel: [self keyViewWithAction: FrotzKeyActionLetters].key.label];
    }
    sHeldActions = nil;
    NSLog(@"kboverlap done");
}

@end

#pragma mark - Settings

@implementation FrotzKeyboardStylePicker (FrotzDebugSelfTest)
// What a tap on that row does.
-(void)selectRow:(NSInteger)row {
    NSIndexPath *indexPath = [NSIndexPath indexPathForRow: row inSection: 0];
    if (row >= 0 && row < [self tableView: self.tableView numberOfRowsInSection: 0])
        [self tableView: self.tableView didSelectRowAtIndexPath: indexPath];
}
@end

@implementation FrotzSettingsController (FrotzDebugSelfTest)
// The Keyboard style row's tap.
-(FrotzKeyboardStylePicker *)showKeyboardStylePicker {
    NSIndexPath *indexPath = [self keyboardStyleIndexPath];
    [m_tableView scrollToRowAtIndexPath: indexPath atScrollPosition: UITableViewScrollPositionMiddle animated: NO];
    [self tableView: m_tableView didSelectRowAtIndexPath: indexPath];
    return m_keyboardStylePicker;
}
@end

#pragma mark - Story view

@implementation RichTextView (FrotzDebugSelfTest)
// Where the selection label was put, CGRectNull if none.
-(CGRect)selectionFrame {
    return m_selectionView.superview == self ? [[self valueForKey: @"m_selectionPresentedFrame"] CGRectValue] : CGRectNull;
}
@end

#pragma mark - Story controller

@implementation StoryMainViewController (FrotzDebugSelfTest)

// Read once, so a failed load isn't retried on every appearance and a choice made in settings sticks.
-(void)showInAppKeyboardIfRequested {
    static BOOL applied;
    if (applied)
        return;
    applied = YES;
    NSDictionary *env = [[NSProcessInfo processInfo] environment];
    NSString *skinID = env[@"FROTZ_INAPP_KEYBOARD"];
    if (skinID.length == 0)
        return;
    m_keyboardController.skinID = [skinID isEqualToString: @"system"] ? nil : skinID;
    if (m_keyboardController.keyboardView && [env[@"FROTZ_INAPP_KEYBOARD_SELFTEST"] boolValue])
        [self performSelector: @selector(runKeyboardSelfTest) withObject: nil afterDelay: 2.0];
}

// Walks Settings > Keyboard Style, picks a row and backs out, since the lane can't tap.
-(void)runSettingsSelfTestIfRequested {
    static BOOL started;
    NSDictionary *env = [[NSProcessInfo processInfo] environment];
    if (started || ![env[@"FROTZ_SETTINGS_SELFTEST"] boolValue])
        return;
    started = YES;
    NSInteger row = env[@"FROTZ_SETTINGS_SELFTEST_ROW"] ? [env[@"FROTZ_SETTINGS_SELFTEST_ROW"] integerValue] : 1;
    [self settingsSelfTestStep: 0 row: row picker: nil];
}

-(void)settingsSelfTestStep:(NSUInteger)step row:(NSInteger)row picker:(nullable FrotzKeyboardStylePicker *)picker {
    FrotzSettingsController *settings = [m_storyBrowser settings];
    NSString *name;
    switch (step) {
        case 0: name = @"start (keyboard up)"; [self activateKeyboard]; break;
        case 1: name = @"settings"; [m_frotzInfoController frotzInfo]; break;
        case 2: name = @"picker"; picker = [settings showKeyboardStylePicker]; break;
        case 3: name = [NSString stringWithFormat: @"select row=%d", (int)row]; [picker selectRow: row]; break;
        case 4: name = @"pop"; [settings.navigationController popViewControllerAnimated: YES]; break;
        case 5: name = @"done-pressed"; [settings donePressed]; break;
        default: name = @"done"; break;
    }
    NSLog(@"kbsettings step %d %@ keyboardStyle=%@ skinID=%@ duoLayoutMode=%@ inAppShowing=%d kbShown=%d lineFirstResponder=%d top=%@", (int)step, name,
          m_keyboardStyle, m_keyboardController.skinID, m_duoLayoutMode, m_keyboardController.isShowing, m_kbShown,
          [m_inputLine isFirstResponder], NSStringFromClass([settings.navigationController.topViewController class]));
    if (step > 5)
        return;
    __weak StoryMainViewController *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf settingsSelfTestStep: step + 1 row: row picker: picker];
    });
}

// Drives the keyboard's own key handling through the typing API, since the simulator can't be
// tapped from a script. Each entry is "tap:<label>", "wait:<seconds>", "story:" (log the end of
// the transcript), "select:last2", "type:<text>" (straight to typeText:, for what no Classic key types),
// "clear:", "hit:<label>" (which view a real touch at that key's centre would reach), "hold:<label>:<seconds>"
// (held as a finger would, so it repeats; logs "kbhold" on release), "a11y:" (the keys' VoiceOver names), "notes:show|hide"
// (the notes page programmatically), "notes:edit" (raise the notes keyboard), "kb:show|hide", "state:" (keyboard source and region),
// "overlap:<shift>:<repeating shift-layer key or empty>:<letter>:<backspace>" (two stand-in fingers at once; logs "kboverlap"),
// "band:" (Flow: scroll the cursor into the fold band and log the input line against its docked frame),
// "mode:classic|flow" (the Duo layout pref, as Settings sets it), "enter:<text>" (type it and return),
// "flowend:" (Flow: the end of the story against the docked input line), "pick:lower|upper" (select a word
// below/above the band), "helper:words|history" and "unhelper:" (the input helper against the band),
// "edges:" (deferred screen edges and the keys' lowest hit), "edgeband:top|bottom|off" (a band over the
// story view's edge) or "note:<text>".
// Not scriptable, so checked by hand: one finger on a key while another's touch is consumed by the
// story or status line (a status line multi-tap, a story magnification phase) in the same event.
// FrotzWindow hands the whole event to UIKit; the story view or status line ignores the consumed
// phase (FrotzTouchIsConsumed) and the key still types, with its "kbtouch" lines as usual.
-(void)runKeyboardSelfTest {
    NSLog(@"kbselftest note: mixed-touch suppression (a key plus a consumed story/status touch in one event) "
          @"needs two real fingers; check by hand that the key types and the story doesn't scroll");
    for (NSString *skinID in [FrotzKeyboardSkin availableSkinIDs]) {
        FrotzKeyboardLayout *layout = [FrotzKeyboardLayout layoutWithID: skinID];
        if (layout && [FrotzKeyboardSkin skinWithID: skinID])
            NSLog(@"kbskin %@ ok rows=%lu units=%g", skinID, (unsigned long)layout.maxRowCount, layout.unitsPerRow);
        else
            NSLog(@"kbskin %@ failed (the loader logs why, once per launch)", skinID);
    }
    NSString *custom = [[NSProcessInfo processInfo] environment][@"FROTZ_SELFTEST_SCRIPT"];
    if (custom.length) {
        [self keyboardSelfTestStep: 0 ofScript: [custom componentsSeparatedByString: @"|"]];
        return;
    }
    // The faithful skins have their own legends: backspace, return and shift, then a few keys of their own.
    NSDictionary<NSString *, NSArray *> *faithful = @{
        @"apple2plus": @[ @"←", @"RETURN", @"SHIFT", @"tap:SHIFT", @"tap:Q", @"tap:1", @"tap:SHIFT", @"tap:1",
                          @"tap:SHIFT", @"tap:N", @"tap:g", @"tap:←", @"tap:ESC", @"tap:RESET" ],
        @"c64": @[ @"DEL", @"RETURN", @"SHIFT", @"tap:SHIFT", @"tap:Q", @"tap:£", @"tap:SHIFT", @"tap:1", @"tap:←", @"tap:↑",
                   @"tap:LOCK", @"tap:A", @"tap:B", @"tap:LOCK", @"tap:c", @"clear:", @"tap:f1", @"tap:f3", @"tap:SHIFT", @"tap:⇕",
                   @"tap:⇕", @"tap:x", @"clear:", @"tap:STOP", @"tap:RESTORE", @"tap:C=", @"tap:CTRL",
                   @"tap:l", @"tap:o", @"tap:o", @"tap:k", @"tap:SHIFT", @"a11y:", @"hold:⇔:1.5", @"wait:1", @"tap:X", @"wait:0.6",
                   @"tap:y", @"hold:⇔:1", @"wait:1.3", @"clear:", @"tap:SHIFT", @"hold:⇕:1.2", @"wait:1.5", @"tap:z" ],
        @"ibmpc": @[ @"⌫", @"↵", @"⇧", @"tap:⇧", @"tap:Q", @"tap:\\", @"tap:⇧", @"tap:1", @"tap:`", @"tap:*",
                     @"tap:Caps Lock", @"tap:A", @"tap:Caps Lock", @"tap:b", @"clear:", @"tap:F1", @"tap:F2",
                     @"tap:Esc", @"tap:⇥", @"tap:Ctrl", @"tap:Alt", @"tap:Num Lock", @"tap:F10" ],
        @"atari400": @[ @"BACK S", @"RETURN", @"SHIFT", @"tap:SHIFT", @"tap:1", @"tap:LOWR", @"tap:A", @"tap:LOWR", @"tap:b",
                        @"tap:<", @"tap:SHIFT", @"tap:<", @"tap:>", @"tap:SHIFT", @"tap:ESC", @"tap:BREAK", @"tap:RESET", @"tap:START", @"tap:◪" ],
        @"atari800": @[ @"BACK S", @"RETURN", @"SHIFT", @"tap:SHIFT", @"tap:1", @"tap:LOWR", @"tap:A", @"tap:LOWR", @"tap:b",
                        @"tap:<", @"tap:SHIFT", @"tap:<", @"tap:>", @"tap:SHIFT", @"tap:ESC", @"tap:BREAK", @"tap:RESET", @"tap:START", @"tap:◪" ],
        @"atari800xl": @[ @"BACK S", @"RETURN", @"SHIFT", @"tap:SHIFT", @"tap:1", @"tap:CAPS", @"tap:A", @"tap:CAPS", @"tap:b",
                          @"tap:<", @"tap:SHIFT", @"tap:<", @"tap:>", @"tap:SHIFT", @"tap:ESC", @"tap:BREAK", @"tap:HELP", @"tap:INVERSE" ],
        @"amiga500": @[ @"⌫", @"Return", @"Shift", @"tap:Shift", @"tap:`", @"tap:\\", @"tap:Caps Lock", @"tap:B", @"tap:Caps Lock",
                        @"tap:c", @"clear:", @"tap:↑", @"tap:↓", @"tap:Esc", @"tap:Help", @"tap:Del", @"tap:F1" ],
        @"amiga1200": @[ @"⌫", @"Return", @"Shift", @"tap:Shift", @"tap:`", @"tap:\\", @"tap:Caps Lock", @"tap:B", @"tap:Caps Lock",
                         @"tap:c", @"clear:", @"tap:↑", @"tap:↓", @"tap:Esc", @"tap:Help", @"tap:Del", @"tap:F1" ],
        @"trs80m3": @[ @"←", @"ENTER", @"SHIFT", @"tap:SHIFT", @"tap:1", @"tap:@", @"tap:SHIFT", @"tap:;", @"clear:", @"tap:↑",
                       @"tap:↓", @"tap:CLEAR", @"tap:BREAK" ],
        @"ibmpcjr": @[ @"⌫", @"↵", @"⇧", @"tap:⇧", @"tap:1", @"tap:'", @"tap:Caps Lock", @"tap:A", @"tap:Caps Lock", @"tap:b",
                       @"clear:", @"tap:↑", @"tap:↓", @"tap:Esc", @"tap:Ins", @"tap:Del" ],
    };
    NSArray *keys = faithful[m_keyboardController.skinID];
    if (keys) {
        NSString *bs = [@"tap:" stringByAppendingString: keys[0]], *ret = [@"tap:" stringByAppendingString: keys[1]];
        NSMutableArray *script = [@[ @"tap:l", @"tap:o", @"tap:o", @"tap:k", bs, bs, @"tap:o", @"tap:k", ret, @"wait:2", @"story:",
                                     [@"tap:" stringByAppendingString: keys[2]], @"tap:L", bs ] mutableCopy];
        [script addObject: @"a11y:"];
        [script addObjectsFromArray: [keys subarrayWithRange: NSMakeRange(3, keys.count - 3)]];
        [script addObject: @"clear:"];
        [script addObject: [NSString stringWithFormat: @"overlap:%@:%@:q:%@", keys[2], [m_keyboardController.skinID isEqualToString: @"c64"] ? @"⇔" : @"", keys[0]]];
        [script addObject: @"clear:"];
        [script addObjectsFromArray: [self flowSelfTestSteps]];
        [self keyboardSelfTestStep: 0 ofScript: script];
        return;
    }
    NSArray *script = @[ @"tap:l", @"tap:o", @"tap:o", @"tap:k", @"tap:⌫", @"tap:⌫", @"tap:o", @"tap:k", @"tap:return", @"wait:2", @"story:",
                         @"tap:i", @"tap:n", @"tap:v", @"tap:space", @"tap:return", @"wait:2", @"story:",
                         @"tap:⇧", @"tap:N", @"tap:123", @"tap:1", @"tap:⌫", @"tap:⌫",
                         @"tap:ABC", @"tap:⇧", @"tap:123", @"tap:←", @"tap:ABC", @"tap:Q", @"tap:⌫", @"tap:123",
                         @"note:single-key: not exercised",
                         @"tap:ABC", @"tap:l", @"tap:o", @"tap:o", @"tap:k", @"select:last2", @"tap:x",
                         @"tap:⌫", @"tap:⌫", @"tap:⌫",
                         @"type:é", @"tap:⌫", @"type:é", @"tap:⌫",
                         @"hit:q", @"hit:⇧", @"hit:space", @"hit:return", @"hit:123",
                         @"tap:l", @"tap:o", @"tap:o", @"tap:k", @"tap:space", @"wait:0.5", @"tap:a", @"tap:t", @"wait:0.5", @"clear:",
                         @"tap:x", @"tap:space", @"wait:0.5", @"clear:",
                         @"state:", @"notes:show", @"wait:0.5", @"state:", @"notes:hide", @"wait:0.5", @"state:",
                         @"kb:hide", @"state:", @"notes:show", @"wait:0.5", @"state:", @"notes:hide", @"wait:0.5", @"state:",
                         @"notes:show", @"notes:edit", @"wait:1", @"state:", @"notes:hide", @"wait:1", @"state:",
                         @"kb:show", @"state:",
                         @"overlap:⇧::q:⌫", @"clear:" ];
    [self keyboardSelfTestStep: 0 ofScript: [script arrayByAddingObjectsFromArray: [self flowSelfTestSteps]]];
}

// In Flow, the docked input line; FROTZ_SELFTEST_TO_CLASSIC=1 then switches to Classic split.
-(NSArray<NSString *> *)flowSelfTestSteps {
    if (![m_duoLayoutMode isEqualToString: @"flow"])
        return @[];
    NSArray *steps = @[ @"state:", @"band:", @"wait:1",
                        @"enter:look", @"wait:2.5", @"flowend:", @"pick:lower", @"wait:1", @"clear:", @"pick:upper", @"wait:1", @"clear:", @"gaptap:", @"clear:",
                        @"helper:words", @"unhelper:", @"helper:history", @"unhelper:",
                        @"helper:short-words", @"unhelper:", @"helper:short-history", @"unhelper:",
                        @"edgeband:top", @"wait:1.5", @"edgeband:bottom", @"wait:1.5", @"edgeband:off", @"wait:0.5", @"flowend:" ];
    if ([[[NSProcessInfo processInfo] environment][@"FROTZ_SELFTEST_TO_CLASSIC"] boolValue])
        steps = [steps arrayByAddingObjectsFromArray: @[ @"mode:classic", @"wait:1", @"state:", @"band:", @"wait:2" ]];
    return steps;
}

-(void)keyboardSelfTestStep:(NSUInteger)step ofScript:(NSArray<NSString *> *)script {
    if (step >= script.count) {
        NSLog(@"kbselftest done");
        return;
    }
    NSString *entry = script[step];
    NSRange colon = [entry rangeOfString: @":"];
    NSString *verb = [entry substringToIndex: colon.location], *arg = [entry substringFromIndex: NSMaxRange(colon)];
    NSTimeInterval next = 0.3;
    if ([verb isEqualToString: @"tap"]) {
        FrotzKeyboardView *keyboard = m_keyboardController.keyboardView;
        if (![keyboard tapKeyWithLabel: arg])
            NSLog(@"kbselftest %d no key \"%@\" in layer %@", (int)step, arg, keyboard.keyLayer);
    } else if ([verb isEqualToString: @"hold"]) {
        NSRange last = [arg rangeOfString: @":" options: NSBackwardsSearch];
        NSString *label = [arg substringToIndex: last.location];
        FrotzKeyboardView *keyboard = m_keyboardController.keyboardView;
        if (![keyboard holdKeyWithLabel: label forSeconds: [[arg substringFromIndex: NSMaxRange(last)] doubleValue]])
            NSLog(@"kbselftest %d no key \"%@\" in layer %@", (int)step, label, keyboard.keyLayer);
    } else if ([verb isEqualToString: @"overlap"]) {
        NSArray<NSString *> *labels = [arg componentsSeparatedByString: @":"];
        if (labels.count == 4)
            [m_keyboardController.keyboardView runOverlapSelfTestWithShift: labels[0] repeatKey: labels[1] letter: labels[2] backspace: labels[3]];
    } else if ([verb isEqualToString: @"a11y"]) {
        FrotzKeyboardView *keyboard = m_keyboardController.keyboardView;
        NSLog(@"kbselftest %d a11y container=\"%@\" type=%ld frame=%@ view=%@ elements=%lu layer=%@ %@", (int)step, keyboard.accessibilityLabel,
              (long)keyboard.accessibilityContainerType, NSStringFromCGRect(keyboard.accessibilityFrame), NSStringFromCGRect([keyboard convertRect: keyboard.bounds toView: nil]),
              (unsigned long)keyboard.accessibilityElements.count, keyboard.keyLayer,
              [[keyboard.accessibilityElements valueForKey: @"accessibilityLabel"] componentsJoinedByString: @" | "]);
    } else if ([verb isEqualToString: @"select"]) {
        UITextPosition *end = m_inputLine.endOfDocument;
        UITextPosition *start = [m_inputLine positionFromPosition: end offset: -2];
        if (start)
            m_inputLine.selectedTextRange = [m_inputLine textRangeFromPosition: start toPosition: end];
    } else if ([verb isEqualToString: @"notes"]) {
        if ([arg isEqualToString: @"show"])
            [m_notesController show];
        else if ([arg isEqualToString: @"edit"])
            [m_notesController activateKeyboard]; // the player opening the notes keyboard
        else
            [m_notesController hide];
    } else if ([verb isEqualToString: @"kb"]) {
        if ([arg isEqualToString: @"show"])
            [m_keyboardController showAnimated: NO];
        else
            [m_keyboardController hideAnimated: NO];
    } else if ([verb isEqualToString: @"state"])
        NSLog(@"kbselftest %d state source=%@ inAppShowing=%d kbShown=%d kbdSize=%@ lineFirstResponder=%d notesVisible=%d notesEditing=%d mode=%@ compact=%d kbFrame=%@ storyFrame=%@ fold=%@",
              (int)step, m_keyboardSource == FrotzKeyboardSourceInApp ? @"InApp" : @"System", m_keyboardController.isShowing,
              m_kbShown, NSStringFromCGSize(m_kbdSize), [m_inputLine isFirstResponder], m_notesController.isVisible,
              m_notesController.isEditingNotes, m_duoLayoutMode, m_keyboardController.keyboardView.compact,
              NSStringFromCGRect(m_keyboardController.keyboardView.frame), NSStringFromCGRect(m_storyView.frame),
              NSStringFromCGRect(m_foldExclusionFrame));
    else if ([verb isEqualToString: @"clear"])
        [m_inputLine setText: @""];
    else if ([verb isEqualToString: @"hit"]) {
        FrotzKeyboardView *keyboard = m_keyboardController.keyboardView;
        CGPoint center = [keyboard centerOfKeyWithLabel: arg];
        CGPoint pt = [keyboard convertPoint: center toView: nil];
        UIView *hit = [keyboard.window hitTest: pt withEvent: nil];
        NSLog(@"kbselftest %d hit %@ at %@ -> %@%@, key %@", (int)step, arg, NSStringFromCGPoint(pt), NSStringFromClass([hit class]),
              hit == keyboard ? @" (keyboard)" : @" (NOT the keyboard)", [keyboard labelOfKeyAtPoint: center]);
    } else if ([verb isEqualToString: @"type"]) {
        [m_inputLine typeText: arg];
        NSLog(@"kbselftest %d utf16 length=%lu", (int)step, (unsigned long)m_inputLine.text.length);
    } else if ([verb isEqualToString: @"wait"])
        next = [arg doubleValue];
    else if ([verb isEqualToString: @"story"]) {
        NSString *story = m_storyView.text ?: @"";
        NSLog(@"kbselftest %d story tail=%@", (int)step, [story substringFromIndex: story.length > 160 ? story.length - 160 : 0]);
    } else if ([verb isEqualToString: @"note"])
        NSLog(@"kbselftest %d %@", (int)step, arg);
    else if ([verb isEqualToString: @"mode"])
        [self setDuoLayoutMode: arg];
    else if ([verb isEqualToString: @"edges"]) {
        // Which controller the system asks for deferred edges (the top full-screen presentation, then
        // its children), and how low the keys take touches.
        UIViewController *vc = self.view.window.rootViewController;
        while (vc.presentedViewController)
            vc = vc.presentedViewController;
        NSMutableArray *chain = [NSMutableArray arrayWithObject: NSStringFromClass([vc class])];
        while (vc.childViewControllerForScreenEdgesDeferringSystemGestures) {
            vc = vc.childViewControllerForScreenEdgesDeferringSystemGestures;
            [chain addObject: NSStringFromClass([vc class])];
        }
        FrotzKeyboardView *keyboard = m_keyboardController.keyboardView;
        NSLog(@"kbselftest %d edges chain=%@ deferred=%lu inAppShowing=%d kbHeight=%g safeBottom=%g lowestHit=%g",
              (int)step, [chain componentsJoinedByString: @" > "], (unsigned long)vc.preferredScreenEdgesDeferringSystemGestures,
              m_keyboardController.isShowing, keyboard.bounds.size.height, keyboard.safeAreaInsets.bottom, [keyboard lowestKeyHitY]);
    }
    else if ([verb isEqualToString: @"band"]) {
        // Put the cursor's line a few points into the band, as scrolling back would.
        CGPoint cursor = [m_storyView cursorPoint];
        CGFloat bandTop = m_storyView.foldBandTop;
        if (m_storyView.foldBandHeight > 0)
            [m_storyView setContentOffset: CGPointMake(0, MAX(0, cursor.y - bandTop - 4)) animated: NO];
        [m_inputLine updatePosition];
        CGRect docked = [self dockedInputFrameForTextView: m_storyView];
        NSLog(@"kbselftest %d band fold=%@ storyFrame=%@ bandTop=%g bandHeight=%g cursorY=%g offset=%g inputLine=%@ docked=%@ isDocked=%d",
              (int)step, NSStringFromCGRect(m_foldExclusionFrame), NSStringFromCGRect(m_storyView.frame), bandTop,
              m_storyView.foldBandHeight, cursor.y - m_storyView.contentOffset.y, m_storyView.contentOffset.y,
              NSStringFromCGRect(m_inputLine.frame), NSStringFromCGRect(docked),
              !CGRectIsNull(docked) && m_inputLine.frame.origin.y == docked.origin.y);
    }
    else if ([verb isEqualToString: @"enter"]) {
        [m_inputLine typeText: arg];
        [m_inputLine typeReturn];
    } else if ([verb isEqualToString: @"flowend"]) {
        // After input is requested: the story at its end, the prompt line against the docked input line,
        // and the gaps at the fold and under the last line.
        RichTextView *v = m_storyView;
        CGFloat offset = v.contentOffset.y, end = MAX(0, v.contentSize.height - v.visibleRect.size.height);
        CGPoint cursor = [v cursorPoint];
        CGFloat lineHeight = [[v font] lineHeight];
        CGRect prompt = [v presentedRectForTextRect: CGRectMake(cursor.x, cursor.y, 10, lineHeight)];
        CGFloat promptY = v.frame.origin.y + prompt.origin.y - offset;
        CGFloat trailing = v.frame.size.height - (CGRectGetMaxY(prompt) - offset) - v.bottomMargin;
        CGFloat splitY = v.foldSplitY, shift = v.foldLowerShift;
        CGRect docked = [self dockedInputFrameForTextView: v];
        NSLog(@"kbselftest %d flowend offset=%g end=%g atEnd=%d bandTop=%g bandHeight=%g splitY(view)=%g shift=%g foldGap=%g "
              "promptY=%g inputLine.y=%g docked.y=%g promptToInput=%g trailingGap=%g kbTop=%g",
              (int)step, offset, end, fabs(offset - end) < 1, v.foldBandTop, v.foldBandHeight, splitY - offset, shift, shift,
              promptY, m_inputLine.frame.origin.y, docked.origin.y, m_inputLine.frame.origin.y - promptY, trailing,
              CGRectIsNull(m_keyboardRegionFrame) ? -1 : CGRectGetMinY(m_keyboardRegionFrame));
    } else if ([verb isEqualToString: @"pick"]) {
        // Select a word on the second line below the band, as a double tap there would, and check the label
        // lands on the tapped point, not where the text would be without the band.
        RichTextView *v = m_storyView;
        CGFloat lineHeight = [[v font] lineHeight];
        CGPoint pt = CGPointMake(v.leftMargin + 12, v.contentOffset.y + v.foldBandTop + v.foldBandHeight + lineHeight * 1.5);
        if ([arg isEqualToString: @"upper"])
            pt.y = v.contentOffset.y + MAX(v.topMargin + lineHeight * 0.5, v.foldBandTop - lineHeight * 2.5);
        // The first word near there (the exact point may fall between words or lines), scanning on screen.
        NSInteger run = -1;
        CGPoint start = pt;
        for (CGFloat dy = 0; dy < lineHeight * 2 && run < 0; dy += 2)
            for (CGFloat x = start.x; x < v.bounds.size.width / 2 && run < 0; x += 4) {
                pt = CGPointMake(x, start.y + dy);
                run = [v getTextRunAtPoint: pt];
            }
        CGRect sel = v.selectionFrame;
        NSLog(@"kbselftest %d pick %@ pt=%@ run=%ld selection=%@ containsPoint=%d inBand=%d", (int)step, arg, NSStringFromCGPoint(pt),
              (long)run, NSStringFromCGRect(sel), !CGRectIsNull(sel) && sel.origin.y <= pt.y && pt.y < CGRectGetMaxY(sel),
              !CGRectIsNull(sel) && CGRectGetMaxY(sel) - v.contentOffset.y > v.foldBandTop && sel.origin.y - v.contentOffset.y < v.foldBandTop + v.foldBandHeight);
    } else if ([verb isEqualToString: @"gaptap"]) {
        // Taps across the gap at the band, as drawn: from the split, through the band and the blank strip
        // under it, to where the lower text starts. Everything in between must map to no text (NAN, no run);
        // from that start down, a point maps to the text the shift above it.
        RichTextView *v = m_storyView;
        CGFloat offset = v.contentOffset.y, splitY = v.foldSplitY, shift = v.foldLowerShift;
        CGFloat bandTop = offset + v.foldBandTop, bandBottom = bandTop + v.foldBandHeight, lowerTop = MAX(splitY + shift, bandBottom);
        CGFloat ys[] = { splitY, bandTop + 1, bandBottom - 1, bandBottom + 1, lowerTop - 1, lowerTop + 0.5, lowerTop + 6 };
        NSMutableArray *parts = [NSMutableArray array];
        BOOL gapOK = YES;
        for (int i = 0; i < 7; i++) {
            CGFloat y = [v textPointForPoint: CGPointMake(v.leftMargin + 12, ys[i])].y;
            NSInteger run = [v getTextRunAtPoint: CGPointMake(v.leftMargin + 12, ys[i])];
            [parts addObject: [NSString stringWithFormat: @"%g->%g/run%ld", ys[i] - offset, y - offset, (long)run]];
            BOOL inGap = ys[i] >= splitY && ys[i] < lowerTop; // over an edge the strip under the band is empty
            if (inGap ? !isnan(y) || run >= 0 : ys[i] >= lowerTop && (isnan(y) || fabs(y - (ys[i] - shift)) > 0.01))
                gapOK = NO;
        }
        NSLog(@"kbselftest %d gaptap splitY(view)=%g shift=%g band(view)=%g-%g lowerTop(view)=%g %@ gapOK=%d", (int)step, splitY - offset,
              shift, bandTop - offset, bandBottom - offset, lowerTop - offset, [parts componentsJoinedByString: @" "], gapOK);
    } else if ([verb isEqualToString: @"helper"]) {
        // The word picker (or with "history", the history list) against the band, in the background's coordinates.
        FrotzInputHelper *helper = [m_inputLine valueForKey: @"m_inputHelper"]; // no accessor for it
        if ([arg isEqualToString: @"history"]) {
            if (![helper historyCount])
                [helper addHistoryItem: @"look"];
            CGPoint pt = [m_inputLine helperLaunchPosition];
            pt.y -= 10; pt.x += 20; // as handleTouch: does
            [helper showInputHelperInView: m_background atPoint: pt withMode: FrotzInputHelperModeHistory];
        } else if ([arg hasPrefix: @"short"]) {
            // "short-words"/"short-history": a 30-pt space to the band, shorter than either helper.
            if (![helper historyCount])
                [helper addHistoryItem: @"look"];
            CGPoint pt = [m_inputLine helperLaunchPosition];
            helper.maxHeight = 30;
            [helper showInputHelperInView: m_background atPoint: pt
                                 withMode: [arg hasSuffix: @"history"] ? FrotzInputHelperModeHistory : FrotzInputHelperModeWords];
        } else
            [m_inputLine launchInputHelper: nil];
        UIView *shown = helper.mode == FrotzInputHelperModeWords ? [m_inputLine inputHelperView] : helper.tableView;
        CGRect frame = [shown.superview convertRect: shown.frame toView: m_background];
        CGRect band = [self foldExclusionInView: m_background];
        NSLog(@"kbselftest %d helper %@ mode=%ld frame=%@ band=%@ maxHeight=%g overlapsBand=%d fits=%d", (int)step, arg, (long)helper.mode,
              NSStringFromCGRect(frame), NSStringFromCGRect(band), helper.maxHeight, CGRectIntersectsRect(frame, band),
              helper.maxHeight <= 0 || frame.size.height <= helper.maxHeight + 0.5);
        next = 1.0;
    } else if ([verb isEqualToString: @"unhelper"])
        [m_inputLine hideInputHelper];
    else if ([verb isEqualToString: @"edgeband"]) {
        // A band over the story view's top or bottom edge, as a Glk buffer starting or ending within the fold
        // would see; "off" puts the real one back.
        RichTextView *v = m_storyView;
        CGRect frame = v.frame;
        if ([arg isEqualToString: @"top"])
            v.foldExclusionRect = CGRectMake(frame.origin.x, frame.origin.y - 10, frame.size.width, 34);
        else if ([arg isEqualToString: @"bottom"])
            v.foldExclusionRect = CGRectMake(frame.origin.x, CGRectGetMaxY(frame) - 20, frame.size.width, 44);
        else
            [self applyFoldExclusion];
        CGFloat end = MAX(0, v.contentSize.height - v.visibleRect.size.height);
        [v setContentOffset: CGPointMake(0, end) animated: NO];
        [v layoutIfNeeded];
        [m_inputLine updatePosition];
        CGRect docked = [self dockedInputFrameForTextView: v];
        CGPoint cursor = [v cursorPoint];
        CGRect prompt = [v presentedRectForTextRect: CGRectMake(cursor.x, cursor.y, 10, [[v font] lineHeight])];
        NSLog(@"kbselftest %d edgeband %@ bandTop=%g bandHeight=%g loss=%g splitY(view)=%g promptBottom(view)=%g inputLine=%@ docked=%@ isDocked=%d",
              (int)step, arg, v.foldBandTop, v.foldBandHeight, frame.size.height - v.visibleRect.size.height, v.foldSplitY - v.contentOffset.y,
              CGRectGetMaxY(prompt) - v.contentOffset.y, NSStringFromCGRect(m_inputLine.frame), NSStringFromCGRect(docked),
              !CGRectIsNull(docked) && m_inputLine.frame.origin.y == docked.origin.y);
    }
    NSLog(@"kbselftest %d %@", (int)step, entry);
    NSLog(@"kbselftest %d text=%@", (int)step, m_inputLine.text);
    if ([m_inputLine.text hasSuffix: @" "])
        NSLog(@"kbselftest %d (text ends in a space; the log trims it)", (int)step);
    if ([arg isEqualToString: @"v"]) {
        CompletionLabel *completion = [m_inputLine valueForKey: @"m_completionLabel"]; // no accessor for it
        NSLog(@"kbselftest %d completion=%@", (int)step, completion.superview ? completion.text : nil);
    }
    __weak StoryMainViewController *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(next * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf keyboardSelfTestStep: step + 1 ofScript: script];
    });
}

@end

#pragma mark - Hooks

static NSString *PhaseName(UITouchPhase phase) {
    switch (phase) {
        case UITouchPhaseBegan: return @"began";
        case UITouchPhaseMoved: return @"moved";
        case UITouchPhaseStationary: return @"stationary";
        case UITouchPhaseEnded: return @"ended";
        case UITouchPhaseCancelled: return @"cancelled";
        default: return [NSString stringWithFormat: @"phase%ld", (long)phase];
    }
}

@implementation FrotzDebugSelfTest

+(void)installInto:(StoryMainViewController *)controller {
    [controller showInAppKeyboardIfRequested];
    [controller runSettingsSelfTestIfRequested];
}

+(BOOL)overridesKeyboardStyle {
    return [[NSProcessInfo processInfo] environment][@"FROTZ_INAPP_KEYBOARD"].length > 0;
}

// A session waiting to be restored already gets to the story screen, and launching over it lands on the story list.
+(void)openStoryAtLaunchWithBrowser:(StoryBrowser *)browser {
    NSString *selfTestStory = [[NSProcessInfo processInfo] environment][@"FROTZ_SELFTEST_STORY"];
    if (!selfTestStory.length || [[browser storyMainViewController] willAutoRestoreSession: YES])
        return;
    [browser setLaunchPath: selfTestStory keepOriginal: YES];
    NSString *launchPath = [browser launchPath];
    if (launchPath) {
        [browser setStoryDetails: [[StoryInfo alloc] initWithPath: launchPath browser: browser]];
        [browser performSelector: @selector(launchStory:) withObject: launchPath afterDelay: 0.05];
    }
}

// Which view a touch on the in-app keyboard really reaches, for touches the keyboard never sees, and
// for the ones it does, the key each lands on.
+(void)window:(UIWindow *)window willSendEvent:(UIEvent *)event {
    FrotzKeyboardView *keyboard = [[[theStoryBrowser storyMainViewController] valueForKey: @"m_keyboardController"] keyboardView];
    if (!keyboard || keyboard.hidden || event.type != UIEventTypeTouches)
        return;
    for (UITouch *touch in [event allTouches]) {
        CGPoint pt = [touch locationInView: keyboard];
        UITouchPhase phase = touch.phase;
        if (phase != UITouchPhaseMoved && phase != UITouchPhaseStationary && [keyboard pointInside: pt withEvent: event])
            NSLog(@"kbtouch window phase=%ld view=%@ at %@ tapCount=%lu", (long)phase,
                  touch.view == keyboard ? @"keyboard" : NSStringFromClass([touch.view class]), NSStringFromCGPoint(pt),
                  (unsigned long)touch.tapCount);
        if (touch.view != keyboard || phase == UITouchPhaseStationary)
            continue;
        FrotzKeyView *keyView = phase == UITouchPhaseBegan ? [keyboard keyViewAtPoint: pt] : [[keyboard selfTestTouchKeys] objectForKey: touch].keyView;
        NSLog(@"kbtouch %@ %@ key=%@ inside=%d", PhaseName(phase), NSStringFromCGPoint(pt),
              keyView ? keyView.key.label : @"(none)", keyView ? [keyboard touch: touch isOnKey: keyView] : 0);
    }
}

+(CGSize)boundsSizeReplacing:(CGSize)size {
    NSArray<NSString *> *fake = [[[NSProcessInfo processInfo] environment][@"FROTZ_FAKE_BOUNDS"] componentsSeparatedByString: @"x"];
    if (fake.count != 2 || fake[0].doubleValue <= 0 || fake[1].doubleValue <= 0)
        return size;
    return CGSizeMake(fake[0].doubleValue, fake[1].doubleValue);
}

+(void)postureDidChange:(FrotzPostureObserver *)observer {
    NSLog(@"posture=%ld angle=%.0f fold=%@ laptop=%d", (long)observer.posture, observer.hingeAngleDegrees,
          NSStringFromCGRect(observer.foldFrameInView), observer.isLaptopPosture);
}

+(BOOL)fakePosture:(nullable FrotzPosture *)posture angle:(nullable CGFloat *)angle fold:(nullable CGRect *)fold inView:(nullable UIView *)view {
    static const CGFloat kFakeFoldHeight = 24.0;
    static BOOL faking;
    static FrotzPosture fakePosture;
    static CGFloat fakeFoldY = -1; // < 0: middle of the view
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSDictionary<NSString *, NSString *> *env = [[NSProcessInfo processInfo] environment];
        NSString *name = [env[@"FROTZ_FAKE_POSTURE"] lowercaseString];
        faking = YES;
        if ([name isEqualToString: @"closed"])
            fakePosture = FrotzPostureClosed;
        else if ([name isEqualToString: @"partial"])
            fakePosture = FrotzPosturePartiallyOpen;
        else if ([name isEqualToString: @"open"])
            fakePosture = FrotzPostureFullyOpen;
        else
            faking = NO;
        // The whole value must be a finite number; anything else falls back to the middle.
        NSScanner *scanner = [NSScanner scannerWithString: env[@"FROTZ_FAKE_FOLD_Y"] ?: @""];
        double foldY;
        if ([scanner scanDouble: &foldY] && scanner.isAtEnd && isfinite(foldY) && foldY >= 0)
            fakeFoldY = foldY;
        else if (env[@"FROTZ_FAKE_FOLD_Y"])
            NSLog(@"FROTZ_FAKE_FOLD_Y=\"%@\" is not a number of points; using the middle", env[@"FROTZ_FAKE_FOLD_Y"]);
    });
    if (!faking)
        return NO;
    if (posture)
        *posture = fakePosture;
    if (angle)
        *angle = fakePosture == FrotzPostureFullyOpen ? 180 : fakePosture == FrotzPosturePartiallyOpen ? 90 : 0;
    if (fold) {
        if (!view || fakePosture == FrotzPostureClosed)
            *fold = CGRectNull;
        else {
            CGRect bounds = view.bounds;
            CGFloat centreY = fakeFoldY >= 0 ? fakeFoldY : bounds.size.height / 2;
            *fold = CGRectMake(bounds.origin.x, bounds.origin.y + centreY - kFakeFoldHeight / 2, bounds.size.width, kFakeFoldHeight);
        }
    }
    return YES;
}

+(BOOL)startFakePostureForObserver:(FrotzPostureObserver *)observer {
    if (![self fakePosture: NULL angle: NULL fold: NULL inView: nil])
        return NO;
    [observer refresh];
    return YES;
}

+(void)replacePosture:(FrotzPosture *)posture angle:(CGFloat *)angle fold:(CGRect *)fold inView:(nullable UIView *)view {
    [self fakePosture: posture angle: angle fold: fold inView: view];
}

+(void)keyboardView:(FrotzKeyboardView *)keyboard willPerformKey:(FrotzKeyboardKey *)key {
    [sHeldActions addObject: key.action == FrotzKeyActionText ? key.text : [key.accessibilityName lowercaseString]];
}

+(void)keyboardView:(FrotzKeyboardView *)keyboard willAnnounce:(NSString *)announcement withLayoutChange:(BOOL)layoutChange {
    NSLog(@"kba11y announce \"%@\" with %@", announcement, layoutChange ? @"layout change" : @"announcement");
}

+(void)notesPageDidChange:(BOOL)notesVisible via:(NSString *)site {
    NSLog(@"kbpage %@ via %@", notesVisible ? @"notes" : @"story", site);
}

@end

NS_ASSUME_NONNULL_END

#endif
