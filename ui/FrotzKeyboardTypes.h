//
//  FrotzKeyboardTypes.h
//  Frotz
//
//  Shared by the in-app keyboard and the input line, so typing need not import the view.
//

#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, FrotzKeyboardSpecialKey) {
    FrotzKeyboardSpecialKeyEscape, FrotzKeyboardSpecialKeyUp, FrotzKeyboardSpecialKeyDown,
    FrotzKeyboardSpecialKeyLeft, FrotzKeyboardSpecialKeyRight
};
