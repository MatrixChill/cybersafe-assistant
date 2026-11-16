#!/usr/bin/env bash
# Disposable Arch lab ONLY, run as root. Creates tmpfs and loop vfat mounts under
# /mnt/cs-lab-qx, runs the engine as the unprivileged user csbuild against
# disposable fixtures, then unmounts and deletes the images. Needs dosfstools.
set -e
[[ ${1:-} == --disposable-lab ]] || { echo 'Use --disposable-lab' >&2; exit 2; }
REPO=${REPO:?set REPO to a built checkout readable by csbuild}
M=/mnt/cs-lab-qx; umount -q $M/* 2>/dev/null || true; rm -rf $M; mkdir -p $M/tmpfs $M/vfat $M/vfatro
mount -t tmpfs -o size=8m,mode=0777 tmpfs $M/tmpfs
truncate -s 32M /tmp/cs-lab-vfat.img; mkfs.vfat /tmp/cs-lab-vfat.img >/dev/null; mount -o loop,uid=1000,gid=1000,umask=077 /tmp/cs-lab-vfat.img $M/vfat
truncate -s 32M /tmp/cs-lab-vfatro.img; mkfs.vfat /tmp/cs-lab-vfatro.img >/dev/null; mount -o loop,uid=1000,gid=1000,umask=077 /tmp/cs-lab-vfatro.img $M/vfatro
su csbuild -c "printf 'benign ro fixture' > $M/vfatro/fixture-vfat-ro.txt"; mount -o remount,ro $M/vfatro
findmnt -no TARGET,FSTYPE,OPTIONS $M/tmpfs $M/vfat $M/vfatro | cut -c1-80
su csbuild -c "TMPFS=$M/tmpfs VFAT=$M/vfat VFATRO=$M/vfatro node $REPO/scripts/linux-lite/verify-quarantine-crossfs.mjs 2>/dev/null"
umount $M/tmpfs $M/vfat $M/vfatro; rm -f /tmp/cs-lab-vfat*.img; rm -rf $M
