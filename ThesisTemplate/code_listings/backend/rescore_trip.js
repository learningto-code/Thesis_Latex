const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
);

const tripId = process.argv[2];
if (!tripId) {
  console.error('Usage: node scripts/rescore_trip.js <trip_id>');
  process.exit(2);
}

// Same physical gate the live path applies before considering a delta suspicious.
function isSuspicious(row, prev) {
  if (!prev || row.fuel_level == null || prev.fuel_level == null) return false;
  if (row.engine_status !== 'on') return false;

  const fuelDelta = row.fuel_level - prev.fuel_level;
  const speed     = Number(row.speed ?? 0);
  const odoDelta  = Math.max(0, (row.odometer_km ?? 0) - (prev.odometer_km ?? 0));

  // Parked-siphon shape: significant drop with (almost) no distance.
  if (speed < 5 && odoDelta < 0.05 && fuelDelta < -4.0) return true;

  // Moving suspicious drop: strictly more than 2 % below the previous
  // -2.0) which are indistinguishable from normal quantization jitter.
  if ((speed >= 5 || odoDelta >= 0.05) && fuelDelta < -2.0) return true;

  return false;
}

async function main() {
  console.log(`[rescore] loading rows for trip ${tripId} ...`);
  const { data: rows, error } = await supabase
    .from('telemetry_logs')
    .select('id, timestamp, comm_channel, fuel_level, odometer_km, speed, engine_status, anomaly_flag')
    .eq('trip_id', tripId)
    .order('timestamp', { ascending: true });

  if (error) {
    console.error('[rescore] fetch failed:', error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.error('[rescore] no telemetry rows for that trip_id');
    process.exit(1);
  }

  console.log(`[rescore] ${rows.length} rows loaded`);

  // Group by channel so we walk each channel's own chronological chain.
  const byChan = new Map();
  for (const r of rows) {
    const k = r.comm_channel ?? '_null';
    if (!byChan.has(k)) byChan.set(k, []);
    byChan.get(k).push(r);
  }

  const desired = new Map(); // id -> boolean anomaly_flag
  let simAnomalies = 0;
  let physAnomalies = 0;

  for (const [chan, list] of byChan) {
    list.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let prev = null;
    for (const r of list) {
      let flag = false;
      if (chan === 'simulation') {
        // Demo-injection rows are the anomaly by construction.
        flag = true;
        simAnomalies++;
      } else if (isSuspicious(r, prev)) {
        flag = true;
        physAnomalies++;
      }
      desired.set(r.id, flag);
      if (r.fuel_level != null) prev = r;
    }
  }

  // (and Supabase write count) minimal.
  const changes = rows.filter(r => desired.get(r.id) !== r.anomaly_flag);
  console.log(`[rescore] ${changes.length} rows need flag change (sim=${simAnomalies}, phys=${physAnomalies})`);

  const CHUNK = 100;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const batch = changes.slice(i, i + CHUNK);
    await Promise.all(batch.map(r =>
      supabase.from('telemetry_logs')
        .update({
          anomaly_flag: desired.get(r.id),
          model_source: desired.get(r.id) ? 'rescore_trip_channel_fix' : null,
        })
        .eq('id', r.id)
    ));
    process.stdout.write(`\r[rescore] updated ${Math.min(i + CHUNK, changes.length)}/${changes.length}`);
  }
  process.stdout.write('\n');

  // Recompute trip_summaries.total_anomalies so the trip card reflects reality.
  const totalAnomalies = [...desired.values()].filter(Boolean).length;
  const { error: sumErr } = await supabase
    .from('trip_summaries')
    .update({ total_anomalies: totalAnomalies })
    .eq('trip_id', tripId);

  if (sumErr) {
    console.warn('[rescore] trip_summaries update failed:', sumErr.message);
  } else {
    console.log(`[rescore] trip_summaries.total_anomalies -> ${totalAnomalies}`);
  }

  // ?? Insert alert rows for each anomaly event window ?????????????????????
  const flaggedRows = rows
    .filter(r => desired.get(r.id))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const events = [];
  for (const r of flaggedRows) {
    const last = events[events.length - 1];
    const gap  = last ? (new Date(r.timestamp) - new Date(last.end)) / 1000 : Infinity;
    if (gap <= 90) {
      last.end = r.timestamp;
      last.rows.push(r);
    } else {
      events.push({ start: r.timestamp, end: r.timestamp, rows: [r] });
    }
  }
  console.log(`[rescore] ${events.length} distinct anomaly event window(s)`);

  const { data: tripMeta, error: tripErr } = await supabase
    .from('trip_sessions')
    .select('truck_id, driver_id')
    .eq('id', tripId)
    .single();
  if (tripErr || !tripMeta) {
    console.warn('[rescore] cannot resolve truck_id/driver_id - skipping alert insert:', tripErr?.message);
    console.log('[rescore] done.');
    return;
  }

  const { data: existingAlerts } = await supabase
    .from('alerts')
    .select('id, timestamp')
    .eq('trip_id', tripId)
    .eq('alert_type', 'fuel_anomaly');
  const existingTimes = (existingAlerts ?? []).map(a => new Date(a.timestamp).getTime());

  let inserted = 0;
  for (const ev of events) {
    const midTs = new Date((new Date(ev.start).getTime() + new Date(ev.end).getTime()) / 2).getTime();
    if (existingTimes.some(t => Math.abs(t - midTs) < 5 * 60_000)) continue;

    const firstFuel = ev.rows[0].fuel_level ?? 0;
    const lastFuel  = ev.rows[ev.rows.length - 1].fuel_level ?? firstFuel;
    const dropPct   = Math.max(0, firstFuel - lastFuel);
    const durSec    = Math.max(1, (new Date(ev.end) - new Date(ev.start)) / 1000);
    const speeds    = ev.rows.map(r => Number(r.speed ?? 0));
    const avgSpeed  = speeds.reduce((s, v) => s + v, 0) / (speeds.length || 1);

    // Same shape-based labelling the live path uses.
    let scenario;
    if (avgSpeed < 5 && dropPct >= 5) scenario = 'Stationary siphon (fuel disappearing while parked)';
    else if (dropPct >= 8)            scenario = 'Rapid fuel drop (excessive loss for engine work)';
    else if (dropPct >= 2)            scenario = 'Unusual fuel drop while driving';
    else                              scenario = 'Fuel anomaly';

    const severity = dropPct >= 5 ? 'high' : dropPct >= 2 ? 'medium' : 'low';
    const message  = `${scenario} - ${dropPct.toFixed(1)}% drop over ${Math.round(durSec)}s at ${Math.round(avgSpeed)} km/h`;

    const { error: insErr } = await supabase.from('alerts').insert([{
      truck_id:   tripMeta.truck_id,
      driver_id:  tripMeta.driver_id,
      trip_id:    tripId,
      alert_type: 'fuel_anomaly',
      severity,
      message,
      timestamp:  new Date(midTs).toISOString(),
    }]);
    if (insErr) console.warn(`[rescore] alert insert failed: ${insErr.message}`);
    else inserted++;
  }
  console.log(`[rescore] inserted ${inserted} new fuel_anomaly alert(s)`);

  // total_alerts on the summary needs to reflect the new inserts too.
  const { count: alertCount } = await supabase
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('trip_id', tripId);
  if (alertCount != null) {
    await supabase.from('trip_summaries').update({ total_alerts: alertCount }).eq('trip_id', tripId);
    console.log(`[rescore] trip_summaries.total_alerts -> ${alertCount}`);
  }

  console.log('[rescore] done.');
}

main().catch(e => { console.error(e); process.exit(1); });
