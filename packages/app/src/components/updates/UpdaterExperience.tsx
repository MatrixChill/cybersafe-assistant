import {UpdaterWindow,type UpdaterWindowProps} from "./UpdaterWindow";
import {UpdaterScene} from "./UpdaterScene";
import "./updater-window.css";
/** Render beneath the application's existing AppearanceProvider. No updater IPC. */
export function UpdaterExperience({forceStatic=false,...props}:UpdaterWindowProps&{forceStatic?:boolean}){
 return <UpdaterWindow {...props} illustration={<UpdaterScene phase={props.view.phase} forceStatic={forceStatic}/>}/>;
}
