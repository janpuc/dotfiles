// Real Pi loader/types, fake terminal: keyboard/focus/render regression, no provider calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { displayText, renderWorkerPanel, showTasks, transcriptText, type WorkerView } from "../../home/dot_pi/shared/extensions/subagent/ui.ts";
export default function workerUITests(pi: ExtensionAPI) {
	pi.registerCommand("test-worker-ui", { description: "Offline UI assertions", handler: async (_args,ctx) => {
		const view: WorkerView = { id:"w1",agent:"worker",task:"wide 界 task",model:"openai/mock",thinking:"low",state:"running",started:new Date().toISOString(),inputTokens:12,outputTokens:3,
			messages:[{role:"assistant",content:[{type:"text",text:"**evidence**"},{type:"thinking",thinking:"private thinking"},{type:"toolCall",name:"read",arguments:{path:"a.ts"}}]}, {role:"toolResult",toolName:"read",content:[{type:"text",text:"tool output"}]}] };
		assert.equal(displayText("\x1b]0;evil\x07safe\x1b[31m text\x1b[0m"),"safe text");
		assert.doesNotMatch(transcriptText(view,0),/private thinking|Tool call|tool output/);
		assert.match(transcriptText(view,1),/Tool call: read/); assert.doesNotMatch(transcriptText(view,1),/private thinking|tool output/);
		assert.match(transcriptText(view,2),/private thinking|tool output/);
		for(const width of [1,8,40,120]) for(const line of renderWorkerPanel([view],false,ctx.ui.theme,width)) assert.ok(visibleWidth(line)<=width);
		assert.deepEqual(renderWorkerPanel([],true,ctx.ui.theme,80),[]);
		assert.deepEqual(renderWorkerPanel([{...view,state:"succeeded"}],false,ctx.ui.theme,80),[]);
		assert.equal(renderWorkerPanel([{...view,state:"failed"}],false,ctx.ui.theme,80).length,1);
		let component:any, unsubs=0, cancelled=0; const submitted:string[]=[];
		let update = () => {};
		const fakeCtx:any = {...ctx, mode:"tui",hasUI:true,ui:{...ctx.ui,theme:ctx.ui.theme,custom:async (factory:any) => new Promise<void>(done => {
			component=factory({requestRender(){},terminal:{rows:24}},ctx.ui.theme,{},done); component.focused=true;
		})}};
		const actions={list:()=>[view],cancel:async()=>{cancelled++},submit:async(_id:string,text:string)=>{submitted.push(text)},subscribe:(fn:()=>void)=>{update=fn;return()=>{unsubs++}}};
		const opening=showTasks(fakeCtx,actions);
		component.render(80); component.handleInput("x"); await new Promise(r=>setTimeout(r,0)); assert.equal(cancelled,1);
		component.handleInput("\r"); assert.ok(component.render(80).some((line:string)=>line.includes(CURSOR_MARKER)));
		component.handleInput("abc"); component.handleInput("q"); component.handleInput("\r"); await new Promise(r=>setTimeout(r,0)); assert.deepEqual(submitted,["abcq"]);
		component.handleInput("\x0f"); assert.ok(component.render(80).some((line:string)=>line.includes("tools")));
		view.partialText="live text"; update(); component.render(80);
		component.handleInput("\x0f"); component.handleInput("\x1b[5~"); component.handleInput("\x1b[F");
		for(const width of [1,8,40,120]) for(const line of component.render(width)) assert.ok(visibleWidth(line)<=width);
		component.handleInput("\x1b"); await opening; assert.equal(cancelled,1); assert.equal(unsubs,1);
		const second=showTasks(fakeCtx,actions); component.handleInput("q"); await second; assert.equal(unsubs,2);
		console.error("WORKER-UI-PASS");
	}});
}
