/*
 FrotzKeyboardController.m

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

#import "FrotzKeyboardController.h"
#import "StoryMainViewController.h"
#import "StoryInputLine.h"
#import "NotesViewController.h"
#import "iosfrotz.h"

static const NSTimeInterval kRedockDuration = 0.25;
static const CGFloat kMaxDockedHeightFraction = 0.45; // landscape phones keep some story

@implementation FrotzKeyboardController {
    __weak StoryMainViewController *m_smvc;
    FrotzPostureObserver *m_observer;
    BOOL m_dockedForLaptop;
    BOOL m_onNotesPage;
    BOOL m_handedToNotes;      // the in-app source is off while the notes page is up
    BOOL m_showOnStoryPage;    // and it was showing when the notes page took over
    BOOL m_restoringStoryPage; // the input line's first-responder change is ours, not a request to show
    CGRect m_dockedFold;       // the fold band the laptop placement was made for
#if DEBUG
    BOOL m_envSkinApplied;
#endif
}

-(instancetype)initWithStoryController:(StoryMainViewController *)smvc postureObserver:(FrotzPostureObserver *)observer {
    if ((self = [super init])) {
        m_smvc = smvc;
        m_observer = observer;
        observer.delegate = self;
    }
    return self;
}

-(BOOL)isInAppKeyboardActive {
    return _keyboardView && m_smvc.activeKeyboardSource == FrotzKeyboardSourceInApp;
}

-(BOOL)isShowing {
    return _keyboardView && !_keyboardView.hidden;
}

#pragma mark Skin

-(void)setSkinID:(NSString *)skinID {
    if ((skinID == _skinID) || [skinID isEqualToString: _skinID])
        return;
    BOOL wasShowing = self.isShowing;
    if (_keyboardView) {
        [self hideAnimated: NO];
        [_keyboardView removeFromSuperview];
        _keyboardView = nil;
        if (!skinID)
            [m_smvc setInAppKeyboardActive: NO];
    }
    _skinID = nil;
    if (!skinID)
        return;
    FrotzKeyboardLayout *layout = [FrotzKeyboardLayout layoutWithID: skinID];
    FrotzKeyboardSkin *skin = [FrotzKeyboardSkin skinWithID: skinID];
    if (!layout || !skin) {
        [m_smvc setInAppKeyboardActive: NO]; // already logged; the system keyboard stays
        return;
    }
    _skinID = [skinID copy];
    _keyboardView = [[FrotzKeyboardView alloc] initWithLayout: layout skin: skin];
    _keyboardView.delegate = self;
    _keyboardView.hidden = YES;
    [m_smvc.view addSubview: _keyboardView]; // not the paging background, which scrolls with the notes
    if (m_onNotesPage) {
        m_handedToNotes = YES;
        m_showOnStoryPage = !m_smvc.KBLocked;
        return;
    }
    [m_smvc setInAppKeyboardActive: YES];
    if (wasShowing || !m_smvc.KBLocked)
        [self showAnimated: NO];
}

#pragma mark Placement

-(BOOL)laptopPostureInBounds:(CGRect)bounds {
    CGRect fold = m_observer.foldFrameInView;
    if (!m_observer.isLaptopPosture || CGRectIsNull(fold) || CGRectIsEmpty(fold))
        return NO;
    // A fold the view doesn't straddle (split view, an odd report) leaves nothing to put below it.
    return CGRectGetMinY(fold) > m_smvc.view.safeAreaInsets.top && CGRectGetMaxY(fold) < CGRectGetMaxY(bounds) - m_smvc.view.safeAreaInsets.bottom;
}

// Laptop posture: from the top of the fold band to the bottom, the keys below the band.
// Otherwise docked at the bottom at the keyboard's natural height.
-(CGRect)keyboardFrameForLaptop:(BOOL)laptop {
    UIView *view = m_smvc.view;
    CGRect bounds = view.bounds;
    UIEdgeInsets safe = view.safeAreaInsets;
    if (laptop) {
        // To the bottom edge, so the case colour runs under the home indicator; the keys stay above it.
        CGFloat top = CGRectGetMinY(m_observer.foldFrameInView);
        return CGRectMake(safe.left, top, bounds.size.width - safe.left - safe.right, bounds.size.height - top);
    }
    // The keyboard keeps its keys out of the home indicator's safe area itself.
    CGFloat height = [_keyboardView preferredHeightForWidth: bounds.size.width] + safe.bottom;
    height = MIN(height, floor(bounds.size.height * kMaxDockedHeightFraction));
    return CGRectMake(0, bounds.size.height - height, bounds.size.width, height);
}

// What the story has to keep clear of: in laptop posture everything from the fold band down,
// so the story and the input line stay in the upper half.
-(CGRect)regionForKeyboardFrame:(CGRect)frame laptop:(BOOL)laptop {
    if (!laptop)
        return frame;
    CGRect bounds = m_smvc.view.bounds;
    return CGRectMake(0, frame.origin.y, bounds.size.width, CGRectGetMaxY(bounds) - frame.origin.y);
}

-(void)applyPlacementForLaptop:(BOOL)laptop frame:(CGRect)frame {
    m_dockedForLaptop = laptop;
    m_dockedFold = laptop ? m_observer.foldFrameInView : CGRectNull;
    _keyboardView.topInset = laptop ? CGRectGetHeight(m_observer.foldFrameInView) : 0;
    _keyboardView.fillsHeight = laptop;
    _keyboardView.frame = frame;
}

-(void)reportRegion:(CGRect)region duration:(NSTimeInterval)duration {
    [m_smvc keyboardRegionWillChange: region visible: YES source: FrotzKeyboardSourceInApp animationDuration: duration];
    [m_smvc keyboardRegionDidChange: region visible: YES source: FrotzKeyboardSourceInApp];
}

// Posture and fold changes, rotation and safe-area changes. Angle-only chatter from the hinge
// lands here too and stops at the comparison.
-(void)redockAnimated:(BOOL)animated {
    if (!self.isInAppKeyboardActive || !self.isShowing)
        return;
    BOOL laptop = [self laptopPostureInBounds: m_smvc.view.bounds];
    CGRect frame = [self keyboardFrameForLaptop: laptop];
    // The band can change height with the same top, which moves the keys but not the frame.
    BOOL sameFold = !laptop || CGRectEqualToRect(m_observer.foldFrameInView, m_dockedFold);
    if (laptop == m_dockedForLaptop && sameFold && CGRectEqualToRect(frame, _keyboardView.frame))
        return;
    NSTimeInterval duration = animated && !UIAccessibilityIsReduceMotionEnabled() ? kRedockDuration : 0;
    [UIView animateWithDuration: duration animations: ^{
        [self applyPlacementForLaptop: laptop frame: frame];
        [self->_keyboardView layoutIfNeeded];
    }];
    [self reportRegion: [self regionForKeyboardFrame: frame laptop: laptop] duration: kRedockDuration];
}

-(void)layoutIfNeeded {
    [self redockAnimated: NO];
}

-(void)postureObserverDidChange:(FrotzPostureObserver *)observer {
#if DEBUG
    NSLog(@"posture=%ld angle=%.0f fold=%@ laptop=%d", (long)observer.posture, observer.hingeAngleDegrees,
          NSStringFromCGRect(observer.foldFrameInView), observer.isLaptopPosture);
#endif
    [self redockAnimated: YES];
}

#pragma mark Show and hide

// The input line stays first responder either way, so the caret and hardware keys keep working.
-(void)showAnimated:(BOOL)animated {
    if (!self.isInAppKeyboardActive || self.isShowing)
        return;
    BOOL laptop = [self laptopPostureInBounds: m_smvc.view.bounds];
    CGRect frame = [self keyboardFrameForLaptop: laptop];
    [self applyPlacementForLaptop: laptop frame: frame];
    _keyboardView.hidden = NO;
    StoryInputLine *inputLine = m_smvc.inputLine;
    if (![inputLine isFirstResponder])
        [inputLine becomeFirstResponder];
    [self reportRegion: [self regionForKeyboardFrame: frame laptop: laptop] duration: animated ? kRedockDuration : 0];
}

-(void)hideAnimated:(BOOL)animated {
    if (!self.isShowing)
        return;
    _keyboardView.hidden = YES;
    [m_smvc keyboardRegionWillChange: CGRectZero visible: NO source: FrotzKeyboardSourceInApp animationDuration: animated ? kRedockDuration : 0];
    [m_smvc keyboardRegionDidChange: CGRectZero visible: NO source: FrotzKeyboardSourceInApp];
}

-(void)inputLineDidBeginEditing {
    if (!m_restoringStoryPage && !m_smvc.KBLocked)
        [self showAnimated: YES];
}

-(void)toggleAnimated:(BOOL)animated {
    if (self.isShowing)
        [self hideAnimated: animated];
    else
        [self showAnimated: animated];
}

#pragma mark Notes page

// The notes text view needs the system keyboard, so the in-app one steps aside for it.
-(void)notesPageDidBecomeVisibleKeyboardFollows:(BOOL)keyboardFollows {
    if (m_onNotesPage)
        return;
    m_onNotesPage = YES;
    if (!self.isInAppKeyboardActive)
        return;
    m_handedToNotes = YES;
    m_showOnStoryPage = self.isShowing;
    [self hideAnimated: NO];
    // The input line is first responder even with the keyboard hidden. Let it go unless the
    // notes view is about to take the keyboard from it (a swipe with the keyboard up); otherwise
    // the switch to the system source would raise a keyboard nobody asked for.
    if (!(m_showOnStoryPage && keyboardFollows))
        [m_smvc.inputLine resignFirstResponder];
    [m_smvc setInAppKeyboardActive: NO];
}

-(void)storyPageDidBecomeVisible {
    if (!m_onNotesPage)
        return;
    m_onNotesPage = NO;
    if (!m_handedToNotes || !_keyboardView)
        return;
    m_handedToNotes = NO;
    m_restoringStoryPage = YES;
    // Put the notes keyboard away while the source is still System, so its notifications clear
    // the region and the in-app source never comes on with a system keyboard on screen.
    NotesViewController *notes = m_smvc.notesController;
    if (notes.isEditingNotes)
        [notes dismissKeyboard];
    [m_smvc setInAppKeyboardActive: YES];
    if (m_showOnStoryPage && !m_smvc.KBLocked)
        [self showAnimated: NO];
    m_restoringStoryPage = NO;
}

#if DEBUG
-(BOOL)applySkinFromEnvironment {
    if (m_envSkinApplied)
        return NO;
    m_envSkinApplied = YES;
    NSString *skinID = [[NSProcessInfo processInfo] environment][@"FROTZ_INAPP_KEYBOARD"];
    if (skinID.length == 0 || _skinID)
        return NO;
    self.skinID = skinID;
    return _keyboardView != nil;
}
#endif

#pragma mark FrotzKeyboardViewDelegate

-(void)keyboardView:(FrotzKeyboardView *)keyboardView didTypeText:(NSString *)text {
    [m_smvc.inputLine typeText: text];
}

-(void)keyboardViewDidBackspace:(FrotzKeyboardView *)keyboardView {
    [m_smvc.inputLine typeBackspace];
}

-(void)keyboardViewDidReturn:(FrotzKeyboardView *)keyboardView {
    // As the system keyboard's return: a key press in single-key mode, and an empty line is
    // still a line (games wait for RETURN), which typeReturn alone would swallow.
    StoryInputLine *inputLine = m_smvc.inputLine;
    if ((ipzAllowInput & kIPZNoEcho) || cwin == 1)
        [inputLine typeText: @"\n"];
    else if (inputLine.text.length > 0)
        [inputLine typeReturn];
    else
        [m_smvc textFieldShouldReturn: inputLine];
}

-(void)keyboardView:(FrotzKeyboardView *)keyboardView didPressSpecialKey:(FrotzKeyboardSpecialKey)key {
    [m_smvc.inputLine typeSpecialKey: key];
}

@end
