/* Diagnostic only: creates no marks, observes no files and denies no access. */
#define _GNU_SOURCE
#include <sys/fanotify.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
int main(void) {
  int fd = fanotify_init(FAN_CLASS_CONTENT | FAN_CLOEXEC | FAN_NONBLOCK, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    printf("{\"permissionGroupAvailable\":false,\"errno\":%d,\"marksCreated\":0,\"preventionTested\":false}\n", errno);
    return 0;
  }
  close(fd);
  puts("{\"permissionGroupAvailable\":true,\"marksCreated\":0,\"preventionTested\":false}");
  return 0;
}
