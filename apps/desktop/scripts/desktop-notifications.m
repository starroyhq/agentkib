#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <dispatch/dispatch.h>

int agentkib_notification_permission(int request) {
  @autoreleasepool {
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block int permission = -1;
    dispatch_async(dispatch_get_main_queue(), ^{
      @try {
        UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
        void (^readSettings)(void) = ^{
          [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            permission = (int)settings.authorizationStatus;
            dispatch_semaphore_signal(completed);
          }];
        };
        if (request) {
          [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                                completionHandler:^(BOOL granted, NSError *error) {
            readSettings();
          }];
        } else {
          readSettings();
        }
      } @catch (NSException *exception) {
        dispatch_semaphore_signal(completed);
      }
    });
    // Called on Koffi's async worker. Keep servicing the main loop during the OS prompt.
    int64_t timeout = (request ? 120 : 5) * NSEC_PER_SEC;
    if (dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, timeout)) != 0)
      return -1;
    return permission;
  }
}

void agentkib_remove_notification(const char *id) {
  @autoreleasepool {
    @try {
      NSString *identifier = [NSString stringWithUTF8String:id];
      if (!identifier) return;
      UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
      [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
      [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
    } @catch (NSException *exception) {
      // A missing notification service should not interrupt session controls.
    }
  }
}
