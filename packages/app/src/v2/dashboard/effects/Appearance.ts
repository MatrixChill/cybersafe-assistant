import {useAppearance as useProductAppearance} from '@/contexts/AppearanceContext';
export function useAppearance(){const x=useProductAppearance();return {p:x.prefs,animate:x.animate,gpu:x.gpu,dpr:x.renderDpr};}
