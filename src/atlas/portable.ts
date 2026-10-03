// Imported before profile readers. The CJS helper remains readable beside the native bundle.
import {app} from 'electron';
import path from 'node:path';
const root=process.env.ATLAS_ROOT || (app.isPackaged?path.dirname(process.execPath):path.resolve(process.cwd(),'build-check/native-profile'));
require('./atlas/bootstrap.cjs').bootstrap(app,root);
