import {ENGINES,STATE_LABEL} from '../model';
export const engines=ENGINES.map(e=>({...e,id:e.key}));
export const stateLabels=STATE_LABEL;
