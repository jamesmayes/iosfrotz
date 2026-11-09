//
//  StoryInputLine.h
//  Frotz
//
//  Created by Craig Smith on 2/9/10.
//  Copyright 2010 Craig Smith. All rights reserved.
//

#import "StoryMainViewController.h"
#import "CompletionLabel.h"
#import "FrotzKeyboardTypes.h"

NS_ASSUME_NONNULL_BEGIN

@interface StoryInputLine: UITextField <FrotzInputDelegate> {
    StoryView *m_storyView;
    StatusLine *m_statusLine;
    UIView *m_enterAndClearView;
    FrotzInputHelper *m_inputHelper;
    UITouchPhase m_lastTouchPhaseSeen;
    NSTimeInterval m_lastTouchTimestamp;
    CGPoint m_touchBeganPosition;
    CompletionLabel *m_completionLabel;
    BOOL m_firstKeyPressed, m_lastCharDeleted;
    BOOL m_justHidHelper;
    BOOL m_completionAmbiguous;
}
-(StoryInputLine*)initWithFrame:(CGRect)frame NS_DESIGNATED_INITIALIZER;
-(instancetype)initWithNibName:(nullable NSString *)nibNameOrNil bundle:(nullable NSBundle *)nibBundleOrNil NS_UNAVAILABLE;
-(instancetype)initWithCoder:(NSCoder *)aDecoder NS_UNAVAILABLE;
@property (nonatomic, strong) StoryView *storyView;
@property (nonatomic, strong) StatusLine *statusLine;
-(void)resetState;
@property (nonatomic, readonly) BOOL updatePosition;
-(BOOL)handleTouch: (UITouch*)touch withEvent: (UIEvent*)event;
-(NSUInteger)addHistoryItem:(NSString*)historyItem;
-(void)inputHelperString:(NSString*)string;
-(void)hideInputHelper;
-(void)launchInputHelper:(nullable id)unused;  // the word picker, as a tap on the input line raises it
-(CGPoint)helperLaunchPosition;      // bottom-left of the helper, in the story's superview; also sizes it clear of a fold band
@property (nonatomic, readonly, strong) UIView *inputHelperView;
-(void)setClearButtonMode;
-(void)maybeShowEnterKey;
-(void)hideEnterKey;
-(void)setTextKeepCompletion:(NSString*)text;

/// Typing API
// One path for every keyboard, so completion, paging and single-key input behave the same.
-(void)typeText:(NSString *)text;
-(void)typeBackspace;
-(void)typeReturn;
-(void)typeSpecialKey:(FrotzKeyboardSpecialKey)key; // what the hardware arrow and escape keys do
@end

NS_ASSUME_NONNULL_END
