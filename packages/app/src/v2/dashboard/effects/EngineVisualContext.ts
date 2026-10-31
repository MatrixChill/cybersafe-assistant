import {createContext} from 'react';
import type {VisualState} from '../model';
export const EngineVisualContext=createContext<Record<string,VisualState>>({yara:'UNAVAILABLE',hashDb:'UNAVAILABLE',clamav:'UNAVAILABLE',nativeEngine:'UNAVAILABLE'});
