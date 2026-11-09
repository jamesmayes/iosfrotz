//
//  FrotzSceneDelegate.m
//  Frotz
//
//  Scene lifecycle delegate. Owns the window and the per-scene setup that
//  previously lived in FrotzAppDelegate's application:didFinishLaunchingWithOptions:.
//

#import "FrotzSceneDelegate.h"
#import "StoryBrowser.h"
#import "StoryMainViewController.h"
#import "StatusLine.h"
#import "StoryInputLine.h"
#import "StoryView.h"
#import "StoryDetailsController.h"
#import "FrotzDB.h"
#import "FrotzAlert.h"
#import "FrotzDebugSelfTest.h"

@interface FrotzWindow : UIWindow
{
}
- (void)sendEvent:(UIEvent *)event;                    // called by UIApplication to dispatch events to views inside the window
@end

// Touches whose current phase the story view, status line or input line consumed (handleTouch:
// returned NO), mapped to the view they were routed to. The event itself still goes to UIKit, so
// every touch keeps its whole lifecycle in UIKit and its gesture recognizers; the routed views
// ignore a consumed phase instead (FrotzTouchIsConsumed). Other touches, such as the in-app
// keyboard's, are never in it.
static NSMapTable<UITouch *, UIView *> *ConsumedTouches(void) {
    static NSMapTable<UITouch *, UIView *> *consumed;
    if (!consumed)
        consumed = [NSMapTable weakToWeakObjectsMapTable];
    return consumed;
}

BOOL FrotzTouchIsConsumed(UITouch *touch) {
    return [ConsumedTouches() objectForKey: touch] != nil;
}

NSSet<UITouch *> *FrotzUnconsumedTouches(NSSet<UITouch *> *touches) {
    NSMapTable<UITouch *, UIView *> *consumed = ConsumedTouches();
    if (consumed.count == 0)
        return touches;
    return [touches objectsPassingTest: ^BOOL(UITouch *touch, BOOL *stop) { return [consumed objectForKey: touch] == nil; }];
}

BOOL FrotzViewHasConsumedTouch(UIView *view) {
    NSMapTable<UITouch *, UIView *> *consumed = ConsumedTouches();
    for (UITouch *touch in consumed)
        if ([[consumed objectForKey: touch] isDescendantOfView: view])
            return YES;
    return NO;
}

@implementation FrotzWindow
- (void)sendEvent:(UIEvent *)event {
    // The view each touch's Began was routed to, for its later phases that arrive with no view.
    static NSMapTable<UITouch *, UIView *> *routedTouches;
    if (!routedTouches)
        routedTouches = [NSMapTable weakToWeakObjectsMapTable];
#if DEBUG
    [FrotzDebugSelfTest window: self willSendEvent: event];
#endif
    NSMapTable<UITouch *, UIView *> *consumed = ConsumedTouches();
    NSSet<UITouch *> *touches = [event allTouches];
    for (UITouch *touch in touches) {
        UIView *view = [touch view];
        UITouchPhase phase = [touch phase];

        if (!view && phase != UITouchPhaseBegan)
            view = [routedTouches objectForKey: touch]; // for some reason sometimes view is nil and we lose the phase ended event!
        BOOL routed = NO, keep = YES;
        if ([touch tapCount]>=1 || phase == UITouchPhaseEnded) {
            if ([view isDescendantOfView: theInputLine]) {
                routed = YES;
                keep = [theInputLine handleTouch: touch withEvent: event];
            } else if ([view isDescendantOfView: theStoryView]) {
                routed = YES;
                keep = [theStoryView handleTouch: touch withEvent: event];
            } else if ([view isDescendantOfView: theStatusLine]) {
                routed = YES;
                keep = [theStatusLine handleTouch: touch withEvent: event];
            }
        }
        if (routed && phase == UITouchPhaseBegan)
            [routedTouches setObject: view forKey: touch];
        else if (phase == UITouchPhaseEnded || phase == UITouchPhaseCancelled)
            [routedTouches removeObjectForKey: touch];
        if (keep)
            [consumed removeObjectForKey: touch];
        else
            [consumed setObject: view forKey: touch]; // only a routed touch, so view is set
    }
    if ([event isKindOfClass: [UIPressesEvent class]]) {
        StoryMainViewController *smvc = [theStoryBrowser storyMainViewController];
        if ([[smvc view] window]
            && ![[smvc navigationController] presentedViewController]
            && ![[smvc notesController] isVisible]) {
            if (theInputLine.isFirstResponder == NO)
                [smvc focusInputLineForHardwareKey];
        }
    }
    [super sendEvent: event];
    for (UITouch *touch in touches)
        if (touch.phase == UITouchPhaseEnded || touch.phase == UITouchPhaseCancelled)
            [consumed removeObjectForKey: touch];
}
@end

// A stock UINavigationController derives the status bar style from its bar's barStyle; this one
// defers to the top view controller so the story screen can pick the adaptive style, which keeps
// the indicators readable where they overlap mixed light and dark content (the Duo's status bar).
@interface FrotzNavigationController : UINavigationController
@end

@implementation FrotzNavigationController
- (UIViewController *)childViewControllerForStatusBarStyle {
    return self.topViewController;
}

- (UIViewController *)childViewControllerForScreenEdgesDeferringSystemGestures {
    return self.topViewController;
}
@end

@implementation FrotzSceneDelegate {
    StoryBrowser *m_browser;
}

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)connectionOptions {
    if (![scene isKindOfClass: [UIWindowScene class]])
        return;
    UIWindowScene *windowScene = (UIWindowScene *)scene;

    // The storyboard is instantiated by hand rather than through UISceneStoryboardFile so that
    // the window can be a FrotzWindow, whose sendEvent: override routes touches to the story views.
    FrotzWindow *window = [[FrotzWindow alloc] initWithWindowScene: windowScene];
    UIStoryboard *storyboard = [UIStoryboard storyboardWithName: @"StoryStoryboard" bundle: nil];
    window.rootViewController = [storyboard instantiateInitialViewController];
    self.window = window;

    m_browser = [window.rootViewController.childViewControllers[0] childViewControllers][0];

    if (connectionOptions.shortcutItem)
        [m_browser setPostLaunch];

    UINavigationController* navigationController = [[FrotzNavigationController alloc] initWithRootViewController: [m_browser storyMainViewController]];
    [m_browser storyMainViewController].storyNavController = navigationController;
    //NSLog(@"smbc snc %@ nc %@", [m_browser storyMainViewController].storyNavController, [m_browser storyMainViewController].navigationController);

    [[UINavigationBar appearance] setTintColor:[UIColor labelColor]];
    [[UIButton appearanceWhenContainedIn: [UITableViewCell class], nil] setTintColor: [UIColor systemIndigoColor]];

    // Button colors are set per container (below) and in the xib files rather than through a
    // global UIButton appearance, because of bugs/misfeatures in the iOS 11 SDK.
    // See: http://www.openradar.me/radar?id=5064333964869632
    [[UIButton appearanceWhenContainedIn: [StoryDetailsController class], nil] setTitleColor: [UIColor whiteColor] forState:UIControlStateNormal];
    
    [[m_browser storyMainViewController] initializeDropbox];

    [m_browser view];
    m_browser.splitViewController.preferredDisplayMode = UISplitViewControllerDisplayModeAutomatic;

    for (UIOpenURLContext *context in connectionOptions.URLContexts)
        [self handleOpenURLContext: context];
#if DEBUG
    [FrotzDebugSelfTest openStoryAtLaunchWithBrowser: m_browser];
#endif

    [window makeKeyAndVisible];
}

- (void)sceneDidEnterBackground:(UIScene *)scene {
    StoryMainViewController *storyMainViewController = [m_browser storyMainViewController];
    [storyMainViewController autoSaveStory];
}

- (void)sceneWillEnterForeground:(UIScene *)scene {
    StoryMainViewController *storyMainViewController = [m_browser storyMainViewController];
    // Unlike applicationWillEnterForeground:, this is also sent on first launch, before the
    // story view has been loaded; avoid forcing the view to load just to resize it.
    if ([storyMainViewController isViewLoaded])
        [storyMainViewController autosize];
    // The Games folder is in the Files app, so stories may have been added or removed meanwhile.
    if ([m_browser isViewLoaded])
        [m_browser reloadData];
}

- (void)windowScene:(UIWindowScene *)windowScene performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem completionHandler:(void (^)(BOOL))completionHandler {
    // UIKit expects exactly one callback per invocation, so unknown shortcut types report failure
    // rather than leaving the shortcut in progress.
    BOOL handled = NO;
    if ([[shortcutItem type] isEqualToString: @"storylist"]) {
        [m_browser setPostLaunch];
        [[m_browser navigationController] popToViewController:m_browser animated:YES];
        handled = YES;
    }
    completionHandler(handled);
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts {
    for (UIOpenURLContext *context in URLContexts)
        [self handleOpenURLContext: context];
}

// A file handed to Frotz comes one of two ways. From a share sheet or an "Open in" it is copied
// into the app's Inbox first, and the copy is ours to move into Games and delete. From the Files
// app (the Documents folder being published there, see LSSupportsOpeningDocumentsInPlace) it is
// opened in place: the URL points at the user's own file, possibly outside the sandbox, readable
// only while security-scoped access is held, and never to be deleted.
- (BOOL)handleOpenURLContext:(UIOpenURLContext *)context {
    NSURL *launchURL = context.URL;
    BOOL inPlace = context.options.openInPlace;
    NSLog(@"openURL %@%@", launchURL, inPlace ? @" (in place)" : @"");
#if UseDropBoxSDK
    DBOAuthCompletion completion = ^(DBOAuthResult *authResult) {
        if (authResult != nil) {
            if ([authResult isSuccess]) {
                NSLog(@"Success! User is logged into Dropbox.");
                [[m_browser navigationController] popViewControllerAnimated: YES];
                [[m_browser storyMainViewController] dropboxDidLinkAccount];
            } else if ([authResult isCancel]) {
                NSLog(@"Authorization flow was manually canceled by user!");
            } else if ([authResult isError]) {
                NSLog(@"Error: %@", authResult);
            }
        }
    };
    BOOL canHandle = [DBClientsManager handleRedirectURL:launchURL completion: completion];
    if (canHandle)
        return YES;
#endif
    if (launchURL && [launchURL isFileURL]) {
        NSString *launchPath = [launchURL path];

        BOOL scoped = inPlace && [launchURL startAccessingSecurityScopedResource];
        [m_browser setLaunchPath: launchPath keepOriginal: inPlace]; // copies into Games while access is held
        if (scoped)
            [launchURL stopAccessingSecurityScopedResource];
        if ((launchPath = [m_browser launchPath])) { // nil if file couldn't be accessed
            [m_browser addRecentStory: launchPath];
            StoryInfo *si = [[StoryInfo alloc] initWithPath: launchPath browser:m_browser];
            [m_browser setStoryDetails: si];
            [m_browser performSelector:@selector(launchStory:) withObject:launchPath afterDelay:0.05];
        }
    } else {
        NSLog(@"Frotz launched w/unknown URL: %@", launchURL);
        FrotzShowAlert(self.window.rootViewController, @"Frotz cannot handle URL",
                       [NSString stringWithFormat:@"%@", launchURL], @"OK", nil, nil);
    }

    return NO;
}

@end
