import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { useRelay, getGatewayView } from '../store/useRelay';
const Tick = createContext(0);
export function TickProvider({ children }: PropsWithChildren) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(timer); }, []);
  return <Tick.Provider value={tick}>{children}</Tick.Provider>;
}
export function useLive() {
  const tick = useContext(Tick);
  const state = useRelay();
  const conveyor = state.snapshot?.conveyors.find(c => c.id === state.selectedId);
  return { ...state, tick, conveyor, view: getGatewayView() };
}
