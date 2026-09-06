#include "../pravaah_serial_node/sensor_math.h"
#include <assert.h>
#include <stdio.h>
using namespace pravaah;
static bool near(float a,float b){return fabs(a-b)<0.001;}
int main(){
  HallPulseFilter filter; uint32_t arrival;
  assert(!filter.transition(10000,false,arrival));
  assert(!filter.transition(10050,true,arrival)); // 50 us noise
  assert(!filter.transition(100000,false,arrival));
  assert(filter.transition(123000,true,arrival)&&arrival==123000); // qualified edge
  assert(!filter.transition(123001,true,arrival)); // held state does not recount
  assert(!filter.transition(123100,false,arrival)); // high phase too short
  assert(!filter.transition(150000,true,arrival));
  assert(filter.lowPulses==3);
  HallPeriod h; float rpm;
  assert(!h.rpm(1000000,1,rpm));
  HallPeriod isolated; isolated.edge(1000);
  assert(!isolated.rpm(6000000,1,rpm));
  HallPeriod slow; slow.edge(1000000);
  assert(!slow.rpm(9000000,1,rpm));
  slow.edge(11000000);
  assert(slow.rpm(11100000,1,rpm)&&near(rpm,6));
  h.edge(1000000); assert(!h.rpm(1100000,1,rpm));
  assert(!h.edge(1000100));
  h.edge(3000000); assert(h.rpm(3100000,1,rpm)&&near(rpm,30));
  assert(h.rpm(3500000,1,rpm)&&near(rpm,30));
  assert(h.rpm(4100000,1,rpm)&&near(rpm,30));
  assert(h.rpm(6100000,1,rpm)&&near(rpm,30)); // hold measurement, do not invent deceleration
  assert(h.rpm(9000000,1,rpm)&&rpm==0);
  h.edge(10000000); assert(!h.rpm(10000010,1,rpm));
  h.edge(12000000);assert(h.rpm(12000010,2,rpm)&&near(rpm,15));
  HallPeriod wrap;wrap.edge(UINT32_MAX-1000000);wrap.edge(999999);
  assert(wrap.rpm(1000100,1,rpm)&&near(rpm,30));
  assert(!wrap.rpm(1000100,0,rpm));
  // Both short-LOW and almost-full-loop LOW signals must produce the same
  // speed. The latter reproduced the live 10-21 RPM sawtooth in 0.2.1.
  const uint32_t widths[]={24000u,2800000u};
  for(uint32_t lowUs : widths) {
    HallPulseFilter dutyFilter; HallPeriod dutyPeriod;
    const uint32_t cycleUs=2830000;
    for(uint32_t cycle=0;cycle<4;++cycle) {
      const uint32_t falling=10000+cycle*cycleUs, rising=falling+lowUs;
      assert(!dutyFilter.transition(falling,false,arrival));
      assert(dutyFilter.transition(rising,true,arrival)&&arrival==rising);
      dutyPeriod.edge(arrival);
      if(cycle>0) {
        assert(dutyPeriod.rpm(rising,1,rpm)&&near(rpm,60000000.0f/cycleUs));
        assert(dutyPeriod.rpm(rising+cycleUs-1,1,rpm)&&near(rpm,60000000.0f/cycleUs));
      }
    }
  }
  Acceleration samples[100];VibrationStats s;
  for(int i=0;i<100;i++)samples[i]={i%2?0.1f:-0.1f,0,1};
  assert(vibrationStats(samples,100,s));assert(near(s.rms,0.1f));assert(near(s.mean.z,1));
  assert(near(s.crest,1)&&near(s.kurtosis,1));
  for(int i=0;i<100;i++)samples[i]={1,0,i%2?0.1f:-0.1f};
  assert(vibrationStats(samples,100,s)&&near(s.rms,0.1f));
  for(auto &a:samples)a={0,0,1};
  assert(vibrationStats(samples,100,s)&&s.rms==0&&!s.ratiosValid);
  assert(!vibrationStats(samples,7,s));
  assert(validAdxlRaw(-2048)&&validAdxlRaw(2047)&&!validAdxlRaw(32767)&&!validAdxlRaw(-2049));
  uint16_t raw=15158;uint8_t frame[]={0xb4,7,0xb5,(uint8_t)raw,(uint8_t)(raw>>8)};
  uint8_t reply[]={frame[3],frame[4],crc8(frame,5)};float c;
  assert(mlxTemperature(0x5a,7,reply,c)&&near(c,30.01));
  reply[2]^=1;assert(!mlxTemperature(0x5a,7,reply,c));
  frame[4]|=0x80;reply[1]=frame[4];reply[2]=crc8(frame,5);
  assert(!mlxTemperature(0x5a,7,reply,c));
  puts("PASS: Hall periods, stop/restart/wrap, multi-axis vibration, raw range, MLX PEC/error flag");
}
