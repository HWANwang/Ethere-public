package com.ethere.app;

import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.PowerManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class PhoneUsageCollector {
    private PhoneUsageCollector() {}

    static JSObject collect(Context context, int requestedMinutes, String requestId) {
        int minutes = Math.max(5, Math.min(10_080, requestedMinutes));
        long end = System.currentTimeMillis();
        long start = end - minutes * 60_000L;
        long baselineStart = Math.max(0, start - 24L * 60L * 60L * 1000L);
        UsageStatsManager manager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        if (manager == null) throw new IllegalStateException("手机使用情况服务不可用");
        UsageEvents events = manager.queryEvents(baselineStart, end);
        if (events == null) throw new IllegalStateException("手机尚未解锁，无法读取使用情况");

        JSArray timeline = new JSArray();
        Map<String, Long> durations = new LinkedHashMap<>();
        Map<String, Long> lastUsed = new LinkedHashMap<>();
        String activePackage = null;
        String activeClass = null;
        long activeSince = start;
        Boolean screenState = null;
        long screenSince = start;
        long interactiveMs = 0;
        long lastScreenChange = 0;
        int unlockCount = 0;
        UsageEvents.Event event = new UsageEvents.Event();

        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            long at = event.getTimeStamp();
            int type = event.getEventType();
            if (type == UsageEvents.Event.ACTIVITY_RESUMED) {
                String pkg = event.getPackageName();
                if (pkg == null || pkg.isEmpty()) continue;
                if (activePackage != null && !activePackage.equals(pkg)) {
                    appendApp(timeline, durations, lastUsed, activePackage, activeSince, at, start, end);
                }
                if (!pkg.equals(activePackage)) activeSince = at;
                activePackage = pkg;
                activeClass = event.getClassName();
            } else if (type == UsageEvents.Event.ACTIVITY_PAUSED) {
                if (activePackage != null && activePackage.equals(event.getPackageName())
                    && (activeClass == null || activeClass.equals(event.getClassName()))) {
                    appendApp(timeline, durations, lastUsed, activePackage, activeSince, at, start, end);
                    activePackage = null;
                    activeClass = null;
                }
            } else if (type == UsageEvents.Event.SCREEN_INTERACTIVE || type == UsageEvents.Event.SCREEN_NON_INTERACTIVE) {
                if (screenState != null) {
                    long from = Math.max(screenSince, start);
                    long to = Math.min(at, end);
                    if (to > from) {
                        appendState(timeline, "screen", screenState ? "on" : "off", from, to);
                        if (screenState) interactiveMs += to - from;
                    }
                }
                screenState = type == UsageEvents.Event.SCREEN_INTERACTIVE;
                screenSince = at;
                if (at >= start) lastScreenChange = at;
                if (!screenState && activePackage != null) {
                    appendApp(timeline, durations, lastUsed, activePackage, activeSince, at, start, end);
                    activePackage = null;
                    activeClass = null;
                }
            } else if (type == UsageEvents.Event.KEYGUARD_SHOWN) {
                if (activePackage != null) {
                    appendApp(timeline, durations, lastUsed, activePackage, activeSince, at, start, end);
                    activePackage = null;
                    activeClass = null;
                }
            } else if (type == UsageEvents.Event.KEYGUARD_HIDDEN && at >= start) {
                unlockCount += 1;
            } else if (type == UsageEvents.Event.DEVICE_SHUTDOWN && activePackage != null) {
                appendApp(timeline, durations, lastUsed, activePackage, activeSince, at, start, end);
                activePackage = null;
                activeClass = null;
            }
        }
        if (activePackage != null) appendApp(timeline, durations, lastUsed, activePackage, activeSince, end, start, end);
        if (screenState != null) {
            long from = Math.max(screenSince, start);
            if (end > from) {
                appendState(timeline, "screen", screenState ? "on" : "off", from, end);
                if (screenState) interactiveMs += end - from;
            }
        }

        PackageManager packageManager = context.getPackageManager();
        JSArray apps = new JSArray();
        for (Map.Entry<String, Long> entry : durations.entrySet()) {
            JSObject app = new JSObject();
            app.put("packageName", entry.getKey());
            app.put("appName", applicationLabel(packageManager, entry.getKey()));
            app.put("foregroundMs", entry.getValue());
            app.put("lastUsedAt", Instant.ofEpochMilli(lastUsed.get(entry.getKey())).toString());
            apps.put(app);
        }
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        JSObject screen = new JSObject();
        screen.put("interactive", power != null && power.isInteractive());
        screen.put("lastChangedAt", lastScreenChange > 0 ? Instant.ofEpochMilli(lastScreenChange).toString() : null);
        screen.put("interactiveMs", interactiveMs);
        screen.put("unlockCount", unlockCount);
        JSObject result = new JSObject();
        result.put("id", "android-events-" + UUID.randomUUID());
        result.put("schemaVersion", 2);
        if (requestId != null && !requestId.isEmpty()) result.put("requestId", requestId);
        result.put("collectedAt", Instant.ofEpochMilli(end).toString());
        result.put("intervalStart", Instant.ofEpochMilli(start).toString());
        result.put("intervalEnd", Instant.ofEpochMilli(end).toString());
        result.put("screen", screen);
        result.put("apps", apps);
        result.put("timeline", timeline);
        return result;
    }

    private static void appendApp(JSArray timeline, Map<String, Long> durations, Map<String, Long> lastUsed,
                                  String pkg, long from, long to, long start, long end) {
        long clippedStart = Math.max(from, start);
        long clippedEnd = Math.min(to, end);
        if (pkg == null || clippedEnd <= clippedStart) return;
        JSObject segment = new JSObject();
        segment.put("type", "app");
        segment.put("packageName", pkg);
        segment.put("startAt", Instant.ofEpochMilli(clippedStart).toString());
        segment.put("endAt", Instant.ofEpochMilli(clippedEnd).toString());
        timeline.put(segment);
        durations.put(pkg, durations.getOrDefault(pkg, 0L) + clippedEnd - clippedStart);
        lastUsed.put(pkg, clippedEnd);
    }

    private static void appendState(JSArray timeline, String type, String state, long from, long to) {
        JSObject segment = new JSObject();
        segment.put("type", type);
        segment.put("state", state);
        segment.put("startAt", Instant.ofEpochMilli(from).toString());
        segment.put("endAt", Instant.ofEpochMilli(to).toString());
        timeline.put(segment);
    }

    private static String applicationLabel(PackageManager packageManager, String packageName) {
        try {
            ApplicationInfo info = packageManager.getApplicationInfo(packageName, 0);
            return String.valueOf(packageManager.getApplicationLabel(info));
        } catch (Exception ignored) {
            return packageName;
        }
    }
}
