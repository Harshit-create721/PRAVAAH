// Only these sensor-linked assemblies can be inspected in the asset view.
// Keep their original IDs so condition and alarm attribution stay unchanged.
export const ROLLER_COMPONENTS = new Set([
  'drive_pulley', 'tail_pulley', 'idlers', 'carry_idlers', 'return_idlers', 'training_idler',
]);
export const SENSOR_COMPONENTS = new Set([
  'drive_motor', 'belt_tracking', 'belt_carcass', ...ROLLER_COMPONENTS,
]);

export function visionDamageReadings(joint) {
  return [
    ['crack_length', 'Crack length'], ['opening', 'Splice opening'], ['edge_separation', 'Edge separation'],
  ].filter(([key]) => Number.isFinite(joint?.last?.[key]) && joint.last[key] > 0)
    .map(([key, label]) => ({ key, label, value: joint.last[key] }));
}

export function canInspectComponent(id, conveyor) {
  return SENSOR_COMPONENTS.has(id) || (id?.startsWith('joint:')
    && visionDamageReadings(conveyor?.joints?.find(j => `joint:${j.id}` === id)).length > 0);
}

export function inspectionChannels(component) {
  const channels = [...(component.watch ?? component.watching ?? [])];
  if (ROLLER_COMPONENTS.has(component.id)) channels.push('hall_rpm');
  if (['belt_tracking', 'belt_carcass'].includes(component.id)) channels.push('belt_speed', 'hall_rpm');
  return [...new Set(channels)];
}
