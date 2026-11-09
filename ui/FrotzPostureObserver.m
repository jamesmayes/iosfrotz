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
// In DEBUG, FROTZ_FAKE_POSTURE can stand in for both (FrotzDebugSelfTest.m).

#import "FrotzPostureObserver.h"
#import "FrotzDebugSelfTest.h"

#if defined(__IPHONE_27_1) && __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
#define FROTZ_HAS_HINGE_API 1
#else
#define FROTZ_HAS_HINGE_API 0
#endif

@implementation FrotzPostureObserver {
    __weak UIView *m_view;
    FrotzPosture m_posture;
    CGFloat m_hingeAngle; // degrees
    CGRect m_foldFrame;
    BOOL m_started;
    NSUInteger m_generation; // bumped on start and stop, so a hinge update queued before either is dropped
    NSObject *m_hingeInteraction; // a UIHingeInteraction; untyped so the ivar builds against older SDKs
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
    if ([FrotzDebugSelfTest startFakePostureForObserver: self]) return; // FROTZ_FAKE_POSTURE replaces the hinge
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
    FrotzPosture posture = m_posture;
    CGFloat angle = m_hingeAngle;
    CGRect fold = [self activeFoldFrame];
#if DEBUG
    [FrotzDebugSelfTest replacePosture: &posture angle: &angle fold: &fold inView: m_view];
#endif
    [self updatePosture:posture angle:angle fold:fold];
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

@end
