-- Application Not Responding (ANR) events across the selected traces.
INCLUDE PERFETTO MODULE android.anrs;

SELECT *
FROM android_anrs
LIMIT 50;
