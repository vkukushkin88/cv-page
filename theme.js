// Applies saved theme, or (if none saved) computes day/night from an
// approximate location derived from the browser's IANA timezone, and
// picks "silver" (light) for daytime / default dark theme for night.
(function () {
  try {
    var saved = localStorage.getItem('theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
      return;
    }

    // Representative [lat, lon] per IANA timezone (approximate, city-level).
    var TZ_COORDS = {
      'Europe/London': [51.5, -0.1], 'Europe/Madrid': [40.4, -3.7],
      'Europe/Paris': [48.9, 2.3], 'Europe/Berlin': [52.5, 13.4],
      'Europe/Rome': [41.9, 12.5], 'Europe/Moscow': [55.8, 37.6],
      'Europe/Kiev': [50.4, 30.5], 'Europe/Kyiv': [50.4, 30.5],
      'Europe/Warsaw': [52.2, 21.0], 'Europe/Amsterdam': [52.4, 4.9],
      'Europe/Lisbon': [38.7, -9.1], 'Europe/Athens': [38.0, 23.7],
      'Europe/Istanbul': [41.0, 28.9], 'Europe/Dublin': [53.3, -6.3],
      'Europe/Stockholm': [59.3, 18.1], 'Europe/Oslo': [59.9, 10.7],
      'Europe/Helsinki': [60.2, 24.9], 'Europe/Zurich': [47.4, 8.5],
      'Europe/Vienna': [48.2, 16.4], 'Europe/Brussels': [50.8, 4.4],
      'Europe/Bucharest': [44.4, 26.1],
      'America/New_York': [40.7, -74.0], 'America/Chicago': [41.9, -87.6],
      'America/Denver': [39.7, -105.0], 'America/Los_Angeles': [34.1, -118.2],
      'America/Anchorage': [61.2, -149.9], 'America/Sao_Paulo': [-23.5, -46.6],
      'America/Argentina/Buenos_Aires': [-34.6, -58.4],
      'America/Mexico_City': [19.4, -99.1], 'America/Bogota': [4.7, -74.1],
      'America/Toronto': [43.7, -79.4], 'America/Vancouver': [49.3, -123.1],
      'Asia/Tokyo': [35.7, 139.7], 'Asia/Shanghai': [31.2, 121.5],
      'Asia/Hong_Kong': [22.3, 114.2], 'Asia/Singapore': [1.35, 103.8],
      'Asia/Seoul': [37.6, 127.0], 'Asia/Kolkata': [28.6, 77.2],
      'Asia/Dubai': [25.2, 55.3], 'Asia/Bangkok': [13.75, 100.5],
      'Asia/Jakarta': [-6.2, 106.8], 'Asia/Manila': [14.6, 121.0],
      'Asia/Karachi': [24.9, 67.0], 'Asia/Jerusalem': [32.1, 34.8],
      'Asia/Riyadh': [24.7, 46.7],
      'Australia/Sydney': [-33.9, 151.2], 'Australia/Melbourne': [-37.8, 145.0],
      'Australia/Perth': [-31.95, 115.9], 'Australia/Brisbane': [-27.5, 153.0],
      'Pacific/Auckland': [-36.8, 174.8],
      'Africa/Cairo': [30.0, 31.2], 'Africa/Johannesburg': [-26.2, 28.0],
      'Africa/Lagos': [6.5, 3.4], 'Africa/Nairobi': [-1.3, 36.8]
    };

    var tz;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    var coords = TZ_COORDS[tz];
    var lat, lon;
    if (coords) {
      lat = coords[0]; lon = coords[1];
    } else {
      // No match: fall back to a temperate-latitude guess and derive
      // longitude from the raw UTC offset.
      lat = 45;
      lon = -(new Date().getTimezoneOffset() / 60) * 15;
    }

    function toRad(d) { return d * Math.PI / 180; }
    function toDeg(r) { return r * 180 / Math.PI; }

    var msPerDay = 86400000;
    var J2000 = Date.UTC(2000, 0, 1, 12, 0, 0); // JD 2451545.0
    var now = new Date();
    var today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));

    // NOAA/"sunrise equation" approximation, good to a few minutes.
    var n = Math.round((today.getTime() - J2000) / msPerDay);
    var Jstar = n - lon / 360;
    var M = (357.5291 + 0.98560028 * Jstar) % 360;
    var Mrad = toRad(M);
    var C = 1.9148 * Math.sin(Mrad) + 0.0200 * Math.sin(2 * Mrad) + 0.0003 * Math.sin(3 * Mrad);
    var lambda = (M + 102.9372 + C + 180) % 360;
    var lambdaRad = toRad(lambda);
    var Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Mrad) - 0.0069 * Math.sin(2 * lambdaRad);
    var delta = Math.asin(Math.sin(lambdaRad) * Math.sin(toRad(23.44)));
    var latRad = toRad(lat);
    var cosOmega = (Math.sin(toRad(-0.83)) - Math.sin(latRad) * Math.sin(delta)) /
                   (Math.cos(latRad) * Math.cos(delta));
    cosOmega = Math.max(-1, Math.min(1, cosOmega)); // clamp for polar day/night
    var omega = toDeg(Math.acos(cosOmega));

    function jdToDate(jd) { return new Date(J2000 + (jd - 2451545.0) * msPerDay); }
    var sunset = jdToDate(Jtransit + omega / 360);
    var sunrise = jdToDate(Jtransit - omega / 360);
    var isNight = now >= sunset || now < sunrise;

    if (!isNight) {
      document.documentElement.setAttribute('data-theme', 'silver');
    }
    // else: leave default (no attribute) — default theme is already dark.
  } catch (e) {}
})();
