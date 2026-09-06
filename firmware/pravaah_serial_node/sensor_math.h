#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>

namespace pravaah {

struct Acceleration { float x, y, z; };
struct VibrationStats {
  Acceleration mean;
  float magnitude, rms, crest, kurtosis;
  bool ratiosValid;
};

// Remove each axis' DC component BEFORE combining axes. Subtracting the mean
// of |a| loses lateral vibration (e.g. alternating +x/-x with constant gravity).
inline bool vibrationStats(const Acceleration *samples, size_t n, VibrationStats &out) {
  if (n < 8) return false;
  double sums[3] = {}, magnitude = 0;
  for (size_t i = 0; i < n; ++i) {
    sums[0] += samples[i].x; sums[1] += samples[i].y; sums[2] += samples[i].z;
    magnitude += sqrt(samples[i].x * samples[i].x + samples[i].y * samples[i].y + samples[i].z * samples[i].z);
  }
  for (int axis = 0; axis < 3; ++axis) sums[axis] /= n;
  out.mean = {(float)sums[0], (float)sums[1], (float)sums[2]};
  out.magnitude = magnitude / n;
  double m2[3] = {}, m4[3] = {}, peakSquared = 0;
  for (size_t i = 0; i < n; ++i) {
    double d[3] = {samples[i].x - sums[0], samples[i].y - sums[1], samples[i].z - sums[2]};
    double total = 0;
    for (int axis = 0; axis < 3; ++axis) {
      const double square = d[axis] * d[axis];
      m2[axis] += square; m4[axis] += square * square; total += square;
    }
    if (total > peakSquared) peakSquared = total;
  }
  const double variance = (m2[0] + m2[1] + m2[2]) / n;
  out.rms = sqrt(variance);
  out.ratiosValid = variance >= 1e-8;
  out.crest = out.kurtosis = 0;
  if (out.ratiosValid) {
    out.crest = sqrt(peakSquared / variance);
    // Kurtosis describes the signed axis with most vibration energy. The
    // positive vector norm does not have the usual Gaussian kurtosis of 3.
    int axis = m2[1] > m2[0] ? 1 : 0;
    if (m2[2] > m2[axis]) axis = 2;
    out.kurtosis = n * m4[axis] / (m2[axis] * m2[axis]);
  }
  return true;
}

inline bool validAdxlRaw(int16_t raw) { return raw >= -2048 && raw <= 2047; }
inline bool clippedAdxlRaw(int16_t raw) { return raw <= -2040 || raw >= 2040; }

inline uint8_t crc8(const uint8_t *bytes, size_t size) {
  uint8_t crc = 0;
  for (size_t i = 0; i < size; ++i) {
    crc ^= bytes[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}

inline bool mlxTemperature(uint8_t address, uint8_t reg, const uint8_t reply[3], float &celsius) {
  const uint8_t frame[] = {(uint8_t)(address << 1), reg, (uint8_t)((address << 1) | 1), reply[0], reply[1]};
  const uint16_t raw = ((uint16_t)reply[1] << 8) | reply[0];
  if (crc8(frame, sizeof(frame)) != reply[2] || (raw & 0x8000) || raw == 0) return false;
  celsius = raw * 0.02f - 273.15f;
  return isfinite(celsius) && celsius >= -40 && celsius <= (reg == 0x06 ? 125 : 380);
}

// Input is one qualified pulse per magnet passage. All time differences use
// unsigned subtraction so an active pulse train survives micros() wraparound.
class HallPeriod {
 public:
  uint32_t count = 0, lastEdgeUs = 0, periodUs = 0;
  bool seen = false, reference = false, measuredPeriod = false;

  uint32_t timeoutUs() const {
    // Allow a full minute to learn the first period or restart at a slower
    // speed. A fixed five-second acquisition timeout cannot measure <12 RPM.
    if (periodUs == 0) return 60000000;
    uint64_t timeout = (uint64_t)periodUs * 3;
    if (timeout < 5000000) timeout = 5000000;
    if (timeout > 60000000) timeout = 60000000;
    return (uint32_t)timeout;
  }

  bool edge(uint32_t now) {
    const uint32_t dt = now - lastEdgeUs;
    if (reference && dt < 5000) return false;
    periodUs = reference && dt < timeoutUs() ? dt : 0;
    if (periodUs > 0) measuredPeriod = true;
    lastEdgeUs = now; reference = seen = true; ++count;
    return true;
  }

  bool rpm(uint32_t now, float magnetsPerCycle, float &value) {
    if (!seen || magnetsPerCycle <= 0) return false;
    const uint32_t age = now - lastEdgeUs;
    if (!reference || age >= timeoutUs()) {
      reference = false; periodUs = 0;
      if (!measuredPeriod) return false; // one isolated glitch cannot establish speed or a stop
      value = 0; return true;
    }
    if (periodUs == 0) return false; // first pulse has no measured period
    // Report the last measured period until the no-pulse timeout. Extending
    // the period using wall-clock age invents a slowdown between detections.
    value = 60000000.0f / periodUs / magnetsPerCycle;
    return true;
  }
};

// Consume timestamped GPIO transitions, including pulses that begin and end
// while the main loop is printing telemetry. Qualify both phases, count once
// on the qualifying rising edge. Use that same edge for the inter-pass
// period and age: a LOW phase can occupy almost an entire belt loop.
class HallPulseFilter {
 public:
  uint32_t changedUs = 0, lastLowUs = 0, maxLowUs = 0, lowPulses = 0;
  uint32_t minStableUs = 2000;
  bool high = true, armed = false;

  bool transition(uint32_t now, bool levelHigh, uint32_t &arrivalUs) {
    if (levelHigh == high) return false;
    const uint32_t duration = now - changedUs;
    changedUs = now; high = levelHigh;
    if (!levelHigh) { armed = duration >= minStableUs; return false; }
    lastLowUs = duration; ++lowPulses;
    if (duration > maxLowUs) maxLowUs = duration;
    const bool accepted = armed && duration >= minStableUs;
    armed = false;
    if (accepted) arrivalUs = now;
    return accepted;
  }
};
} // namespace pravaah
