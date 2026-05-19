#!/usr/bin/env sh
set -eu

echo "DISPLAY=${DISPLAY:-}"
echo "framebuffer_devices:"
ls -l /dev/fb* 2>/dev/null || true
echo "dri_devices:"
ls -l /dev/dri 2>/dev/null || true
echo "x_server:"
xdpyinfo 2>/dev/null | awk '/name of display|dimensions|depth of root/ { print }' || true

if ls /dev/fb* >/dev/null 2>&1; then
  echo "framebuffer_probe=present"
else
  echo "framebuffer_probe=absent"
fi

if [ -d /dev/dri ]; then
  echo "dri_probe=present"
else
  echo "dri_probe=absent"
fi
