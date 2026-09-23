// sun.mjs — where the sun is, worked out here rather than asked for.
//
// The map's light follows the real sun over wherever you are looking: gold
// at sunrise and sunset, bright by day, neon at night. Accurate to a fraction
// of a degree, which is far more than a colour needs.

const RAD = Math.PI / 180;

export function sunPosition(date, lat, lng) {
  // Days since noon on 1 January 2000 (J2000).
  const d = date.getTime() / 86400000 - 10957.5;
  const g = RAD * (357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const lon = RAD * (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = RAD * (23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(lon), Math.cos(lon));
  const dec = Math.asin(Math.sin(e) * Math.sin(lon));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = RAD * (gmst * 15 + lng) - ra;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { altitude: alt / RAD, azimuth: ((az / RAD) % 360 + 360) % 360 };
}

// Which light, from how high the sun is: 0 is night, 1 golden hour, 2 day,
// with the steps in between blended rather than switched.
export function phaseOf(altitude) {
  if (altitude <= -8) return 0;
  if (altitude < -2) return (altitude + 8) / 6;
  if (altitude <= 6) return 1;
  if (altitude < 14) return 1 + (altitude - 6) / 8;
  return 2;
}
