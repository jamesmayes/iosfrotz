/*
 FrotzPostureObserver.m

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

// The hinge state comes from UIHingeInteraction (UIHingeInteraction.h, UIHinge.h) and the fold from
// the view's division reserved regions (UIViewReservedRegion.h, UIView (ReservedRegion)), all iOS 27.1.
//
// DEBUG builds only, so every layout can be tried on a simulator without a hinge to turn. Read once in
// -start; when set they win over the real API:
//   FROTZ_FAKE_POSTURE=closed|partial|open
//   FROTZ_FAKE_FOLD_Y=<points>  centre of the fake fold from the top of the view (default: half the
//                               view height). The fake fold is 24pt tall and full width; none when closed.

#import "FrotzPostureObserver.h"

#if defined(__IPHONE_27_1) && __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
#define FROTZ_HAS_HINGE_API 1
#else
#define FROTZ_HAS_HINGE_API 0
#endif

#if DEBUG
static const CGFloat kFakeFoldHeight = 24.0;
#endif

@implementation FrotzPostureObserver {
    __weak UIView *m_view;
    FrotzPosture m_posture;
    CGFloat m_hingeAngle; // degrees
    CGRect m_foldFrame;
    BOOL m_started;
    NSUInteger m_generation; // bumped on start and stop, so a hinge update queued before either is dropped
    NSObject *m_hingeInteraction; // a UIHingeInteraction; untyped so the ivar builds against older SDKs
#if DEBUG
    BOOL m_faking;
    FrotzPosture m_fakePosture;
    CGFloat m_fakeFoldY; // < 0: middle of the view
#endif
}

-(instancetype)initWithView:(UIView *)view {
    if ((self = [super init])) {
        m_view = view;
        m_posture = FrotzPostureUnknown;
        m_foldFrame = CGRectNull;
    }
    return self;
}

+(BOOL)isSupported {
#if FROTZ_HAS_HINGE_API
    if (@available(iOS 27.1, *))
        return YES;
#endif
    return NO;
}

-(FrotzPosture)posture {
    return m_posture;
}

-(CGFloat)hingeAngleDegrees {
    return m_hingeAngle;
}

-(CGRect)foldFrameInView {
    return m_foldFrame;
}

-(BOOL)isLaptopPosture {
    return m_posture == FrotzPosturePartiallyOpen && !CGRectIsNull(m_foldFrame)
        && m_foldFrame.size.width > m_foldFrame.size.height;
}

-(void)start {
    NSAssert([NSThread isMainThread], @"FrotzPostureObserver is main-thread only");
    if (m_started)
        return;
    m_started = YES;
    NSUInteger generation = ++m_generation;
#if DEBUG
    [self readFakePosture];
    if (m_faking) {
        [self refresh];
        return;
    }
#endif
#if FROTZ_HAS_HINGE_API
    if (@available(iOS 27.1, *)) {
        UIView *view = m_view;
        if (!view)
            return;
        __weak FrotzPostureObserver *weakSelf = self;
        UIHingeInteraction *interaction = [[UIHingeInteraction alloc] initWithUpdateHandler:^(UIHingeInteraction *hingeInteraction, UIHingeInteractionUpdate *update) {
            UIHinge *hinge = update.hinge;
            dispatch_block_t apply = ^{ [weakSelf hingeDidUpdate: hinge generation: generation]; };
            if ([NSThread isMainThread])
                apply();
            else
                dispatch_async(dispatch_get_main_queue(), apply);
        }];
        m_hingeInteraction = interaction;
        [view addInteraction: interaction];
    }
#endif
}

-(void)stop {
    NSAssert([NSThread isMainThread], @"FrotzPostureObserver is main-thread only");
    if (!m_started)
        return;
    m_started = NO;
    m_generation++;
#if FROTZ_HAS_HINGE_API
    if (@available(iOS 27.1, *)) {
        UIHingeInteraction *interaction = (UIHingeInteraction *)m_hingeInteraction;
        if (interaction)
            [interaction.view removeInteraction: interaction];
    }
#endif
    m_hingeInteraction = nil;
}

-(void)refresh {
    NSAssert([NSThread isMainThread], @"FrotzPostureObserver is main-thread only");
    if (!m_started)
        return;
#if DEBUG
    if (m_faking) {
        [self updatePosture:m_fakePosture angle:[self angleForFakePosture] fold:[self fakeFoldFrame]];
        return;
    }
#endif
    [self updatePosture:m_posture angle:m_hingeAngle fold:[self activeFoldFrame]];
}

#if FROTZ_HAS_HINGE_API
-(void)hingeDidUpdate:(nullable UIHinge *)hinge generation:(NSUInteger)generation API_AVAILABLE(ios(27.1)) {
    if (!m_started || generation != m_generation)
        return;
    FrotzPosture posture = FrotzPostureUnknown;
    CGFloat angle = 0;
    // A nil hinge means the view left a hierarchy that reports one.
    if (hinge) {
        switch (hinge.status) {
            case UIHingeStatusClosed:        posture = FrotzPostureClosed; break;
            case UIHingeStatusPartiallyOpen: posture = FrotzPosturePartiallyOpen; break;
            case UIHingeStatusFullyOpen:     posture = FrotzPostureFullyOpen; break;
            default:                         posture = FrotzPostureUnknown; break;
        }
        if (posture != FrotzPostureUnknown)
            angle = hinge.angle * 180.0 / M_PI;
    }
    [self updatePosture:posture angle:angle fold:[self activeFoldFrame]];
}
#endif

// The first active division region, already in the view's coordinates (that's what the query returns).
-(CGRect)activeFoldFrame {
#if FROTZ_HAS_HINGE_API
    if (@available(iOS 27.1, *)) {
        UIView *view = m_view;
        if (!view || !m_hingeInteraction)
            return CGRectNull;
        for (UIViewReservedRegion *region in [view reservedRegionsOfKind: [UIViewReservedRegionKind divisionRegionKind]]) {
            if (region.isActive)
                return region.frame;
        }
    }
#endif
    return CGRectNull;
}

-(void)updatePosture:(FrotzPosture)posture angle:(CGFloat)angle fold:(CGRect)fold {
    if (posture == m_posture && angle == m_hingeAngle && CGRectEqualToRect(fold, m_foldFrame))
        return;
    m_posture = posture;
    m_hingeAngle = angle;
    m_foldFrame = fold;
    [self.delegate postureObserverDidChange: self];
}

#if DEBUG
-(void)readFakePosture {
    NSDictionary<NSString *, NSString *> *env = [[NSProcessInfo processInfo] environment];
    NSString *posture = [env[@"FROTZ_FAKE_POSTURE"] lowercaseString];
    m_faking = YES;
    if ([posture isEqualToString: @"closed"])
        m_fakePosture = FrotzPostureClosed;
    else if ([posture isEqualToString: @"partial"])
        m_fakePosture = FrotzPosturePartiallyOpen;
    else if ([posture isEqualToString: @"open"])
        m_fakePosture = FrotzPostureFullyOpen;
    else
        m_faking = NO;
    // The whole value must be a finite number; anything else falls back to the middle.
    NSScanner *scanner = [NSScanner scannerWithString: env[@"FROTZ_FAKE_FOLD_Y"] ?: @""];
    double foldY;
    m_fakeFoldY = -1;
    if ([scanner scanDouble: &foldY] && scanner.isAtEnd && isfinite(foldY) && foldY >= 0)
        m_fakeFoldY = foldY;
    else if (env[@"FROTZ_FAKE_FOLD_Y"])
        NSLog(@"FROTZ_FAKE_FOLD_Y=\"%@\" is not a number of points; using the middle", env[@"FROTZ_FAKE_FOLD_Y"]);
}

-(CGFloat)angleForFakePosture {
    switch (m_fakePosture) {
        case FrotzPostureClosed:        return 0;
        case FrotzPosturePartiallyOpen: return 90;
        case FrotzPostureFullyOpen:     return 180;
        default:                        return 0;
    }
}

-(CGRect)fakeFoldFrame {
    UIView *view = m_view;
    if (!view || m_fakePosture == FrotzPostureClosed || m_fakePosture == FrotzPostureUnknown)
        return CGRectNull;
    CGRect bounds = view.bounds;
    CGFloat centreY = m_fakeFoldY >= 0 ? m_fakeFoldY : bounds.size.height / 2;
    return CGRectMake(bounds.origin.x, bounds.origin.y + centreY - kFakeFoldHeight / 2, bounds.size.width, kFakeFoldHeight);
}
#endif

@end
