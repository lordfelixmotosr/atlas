import {editorText,fileText} from './editor-text';
import {useEffect,useRef} from 'react';
import {basicSetup,EditorView} from 'codemirror';
import {EditorState} from '@codemirror/state';
import {keymap} from '@codemirror/view';
import {indentWithTab} from '@codemirror/commands';
import {StreamLanguage,syntaxHighlighting,HighlightStyle} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import {xml} from '@codemirror/lang-xml';
import {csharp} from '@codemirror/legacy-modes/mode/clike';

const colors=HighlightStyle.define([
 {tag:[tags.keyword,tags.modifier],color:'#bdc6ec'},
 {tag:[tags.string,tags.attributeValue],color:'#d9c99b'},
 {tag:[tags.tagName,tags.typeName,tags.className],color:'#9ebfce'},
 {tag:[tags.number,tags.bool],color:'#d6b2c6'},
 {tag:[tags.comment,tags.meta],color:'#828595'},
 {tag:tags.attributeName,color:'#bdc6dc'},
]);
const theme=EditorView.theme({
 '&':{height:'100%',fontSize:'12px',backgroundColor:'#131316',color:'#dedee5'},
 '.cm-scroller':{fontFamily:'"JetBrains Mono",monospace',overflow:'auto'},
 '.cm-content':{padding:'10px 0'},'.cm-line':{padding:'0 12px'},
 '.cm-gutters':{backgroundColor:'#17171b',borderRight:'1px solid #303038',color:'#747787'},
 '.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'#ffffff05'},
 '.cm-cursor':{borderLeftColor:'#bdc6ec'},'&.cm-focused .cm-selectionBackground,.cm-selectionBackground':{backgroundColor:'#a9b7df35'},
 '.cm-panels':{backgroundColor:'#202026',color:'#dedee5'},'.cm-textfield':{backgroundColor:'#131316',border:'1px solid #44444e'},
 '.cm-button':{backgroundImage:'none',backgroundColor:'#292932',color:'#dedee5',border:'1px solid #44444e'},
 '&.cm-focused':{outline:'none'},'.cm-searchMatch':{backgroundColor:'#b7c4ec30',outline:'1px solid #b7c4ec70'},
},{dark:true});
export type EditorLocation={line:number;column?:number;key:number};
export function CodeEditor({path,text,onChange,onSave,location,onCursor,states,lineSeparator}: {
 path:string;text:string;onChange:(text:string)=>void;onSave:()=>void;location?:EditorLocation|null;onCursor?:(line:number,column:number)=>void;states?:Map<string,EditorState>;lineSeparator?:'\n'|'\r\n';
}){
 const mount=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),callbacks=useRef({onChange,onSave,onCursor,lineSeparator:lineSeparator??(text.includes('\r\n')?'\r\n':'\n') as '\n'|'\r\n'});
 callbacks.current={onChange,onSave,onCursor,lineSeparator:lineSeparator??callbacks.current.lineSeparator};
 useEffect(()=>{
  if(!mount.current)return;
  const language=/\.(xml|csproj|props)$/i.test(path)?xml():/\.cs$/i.test(path)?StreamLanguage.define(csharp):[];
  const editor=new EditorView({parent:mount.current,state:states?.get(path)??EditorState.create({doc:editorText(text),extensions:[
   basicSetup,language,theme,syntaxHighlighting(colors),EditorView.contentAttributes.of({'aria-label':'Edit '+path}),
   keymap.of([{key:'Mod-s',run:()=>{callbacks.current.onSave();return true;}},indentWithTab]),
   EditorView.updateListener.of(update=>{
    if(update.docChanged)callbacks.current.onChange(fileText(update.state.doc.toString(),callbacks.current.lineSeparator));
    if(update.selectionSet||update.docChanged){const pos=update.state.selection.main.head,line=update.state.doc.lineAt(pos);callbacks.current.onCursor?.(line.number,pos-line.from+1);}
   }),
  ]})});
  view.current=editor;
  return()=>{states?.set(path,editor.state);view.current=null;editor.destroy();};
 },[path]);
 useEffect(()=>{const editor=view.current;if(editor&&editor.state.doc.toString()!==editorText(text))editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:editorText(text)}});},[text]);
 useEffect(()=>{
  const editor=view.current;if(!editor||!location)return;
  const line=editor.state.doc.line(Math.min(editor.state.doc.lines,Math.max(1,location.line))),at=Math.min(line.to,line.from+Math.max(0,(location.column??1)-1));
  editor.dispatch({selection:{anchor:at},effects:EditorView.scrollIntoView(at,{y:'center'})});editor.focus();
 },[path,location]);
 return <div className="atlas-code-editor" ref={mount}/>;
}
