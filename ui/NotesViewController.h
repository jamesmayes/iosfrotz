//
//  NotesViewController.h
//  Frotz
//
//  Created by Craig Smith on 9/6/10.
//  Copyright 2010 Craig Smith. All rights reserved.
//

#import <UIKit/UIKit.h>
#import "FileBrowser.h"

NS_ASSUME_NONNULL_BEGIN

@protocol LockableKeyboard <NSObject>
-(void)showKeyboardLockState;
@optional
// Before first responder can move to or from the notes. keyboardFollows: the notes view is about to
// take the keyboard over from the input line (a swipe), rather than the page changing on its own.
-(void)notesPageDidBecomeVisible:(BOOL)visible keyboardFollows:(BOOL)keyboardFollows;
@end

@interface NotesViewController : UIViewController <UIScrollViewDelegate, UITextViewDelegate, FileSelected> {
    CGRect m_frame;
    
    UISegmentedControl *m_notesTitle;
    
    UIScrollView *m_scrollView;
    UITextView *m_notesView;
    UIView *m_notesBGView;
    UIResponder *m_chainResponder;
    NSString *m_fontName;
    NSInteger m_defaultFontSize;
    
    UIViewController<TextFileBrowser,FileSelected, LockableKeyboard> __weak *m_delegate;
}

-(instancetype)initWithFrame:(CGRect)frame NS_DESIGNATED_INITIALIZER;
-(instancetype)initWithNibName:(nullable NSString *)nibNameOrNil bundle:(nullable NSBundle *)nibBundleOrNil NS_UNAVAILABLE;
-(nullable instancetype)initWithCoder:(NSCoder *)aDecoder NS_UNAVAILABLE;
@property (nullable, nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSString *text;
@property (nonatomic, copy, nullable) UIFont *font;
-(void)setFrame:(CGRect)frame;
@property (nonatomic, strong) UIResponder *chainResponder;
-(void)activateKeyboard;
-(void)dismissKeyboard;
-(void)toggleKeyboard;
@property (nonatomic, readonly, strong) UIScrollView *containerScrollView;
-(void) keyboardWillShow:(CGRect)kbBounds;
-(void) keyboardWillHide;
@property (nonatomic, getter=isVisible, readonly) BOOL visible;
@property (nonatomic, readonly) BOOL isEditingNotes;    // the notes text view is first responder
-(void)show;
-(void)hide;
-(void)loadView;
-(void)autosize;
-(void)setFontName: (nullable NSString*)fontName;
-(void)setFont: (NSString*)fontName withSize:(NSInteger)size;
-(UIFont*)fixedFont;
@property (nonatomic) NSInteger defaultFontSize;
-(BOOL)hasCustomDefaultFontSize;
-(NSInteger)fontSize;
@property (nonatomic, readonly, copy) NSString *fontName;
-(void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView;
- (void)willRotateToInterfaceOrientation:(UIInterfaceOrientation)toInterfaceOrientation duration:(NSTimeInterval)duration;
-(void)didRotateFromInterfaceOrientation:(UIInterfaceOrientation)fromInterfaceOrientation;
-(void)viewWillAppear:(BOOL)animated;
-(void)viewWillDisappear:(BOOL)animated;
@property (nonatomic, weak) UIViewController<TextFileBrowser,FileSelected,LockableKeyboard>* delegate;
-(void)workaroundFirstResponderBug;
@end

NS_ASSUME_NONNULL_END
