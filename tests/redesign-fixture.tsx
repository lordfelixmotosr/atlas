// @ts-nocheck
import './redesign-preload';
import {createRoot} from 'react-dom/client';
import {App} from '../src/App';
import {AppDialog} from '../src/components/app-dialog';
createRoot(document.getElementById('root')!).render(<><App/><AppDialog/></>);
