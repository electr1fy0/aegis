let assets;
const C={ink:'#17222A',white:'#FFFFFF',orange:'#FF6429',mist:'#E9EEF1',gray:'#AEB9C0',slate:'#687A86',red:'#D74737'};
const F='Avenir Next';
function txt(s,value,x,y,w,h,size=28,{color=C.ink,bold=false,align='left',...rest}={}){
 const t=s.shapes.add({geometry:'textbox',name:value.slice(0,64),position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
 t.text=value;t.text.style={typeface:F,fontSize:size,bold,color,alignment:align,insets:0,autoFit:'none',verticalAlignment:'top',...rest};return t;
}
function page(p,bg,notes){const s=p.slides.add({width:1280,height:720});s.background.fill=bg;s.speakerNotes.text=notes;return s;}
function photo(s,name,x,y,w,h,{crop,fit='contain'}={}){return s.images.add({path:`${assets}/${name}`,contentType:'image/png',alt:name.replaceAll('-',' ').replace('.png',''),position:{left:x,top:y,width:w,height:h},fit,...(crop?{crop}:{})});}
function chartFont(ch){for(const st of [ch.legend?.textStyle,ch.dataLabels?.textStyle,ch.xAxis?.textStyle,ch.yAxis?.textStyle])if(st)st.typeface=F;return ch;}

export async function build(p,{assetDirectory=new URL('../latex-report/screenshots/',import.meta.url).pathname}={}){
 assets=assetDirectory;p.slides.keep([]);
 let s=page(p,C.orange,'Aegis implements AI Innovate-A-Thon Topic 10 as a synthetic campus event exercise prototype. Contributors: Ayush Pandey, 24BIT0394, and Dheeraj Sutram, 24BIT0416. The background detail is cropped from the genuine application screenshot and shows an illustrative schematic. Source: README.md and docs/latex-report/screenshots/dashboard-wide.png.');
 photo(s,'dashboard-wide.png',732,0,548,720,{crop:{left:0.285,top:0.357,right:0.323,bottom:0},fit:'cover'});
 txt(s,'AI Innovate-A-Thon, Topic 10',58,35,640,42,24);
 txt(s,'Aegis',48,102,680,220,170,{bold:true});
 txt(s,'Emergency First-Response\nCoordination',58,352,640,118,38,{bold:true});
 txt(s,'A campus event exercise prototype',58,493,635,48,26);
 txt(s,'Ayush Pandey  24BIT0394\nDheeraj Sutram  24BIT0416',58,613,640,68,24);

 s=page(p,C.white,'Three selected accounts from the Exit A demo family illustrate the coordination problem. The replay family contains four reports overall. The displayed quotes are source clauses from demo reports 4, 10 and the later clear-door account. Opposing reports may describe a changing situation or conflicting accounts. Source: data/scenarios/demo.json.');
 txt(s,'Exit A',56,40,900,120,94,{bold:true});txt(s,'Three accounts of the same doorway',62,166,1050,56,32);
 txt(s,'“The inner door at Exit A\nwill not open.”',62,276,810,100,38,{bold:true});
 txt(s,'“The inside Exit A door\nseems jammed.”',62,416,810,100,38,{bold:true});
 txt(s,'“Exit A doorway is clear”',62,566,810,65,38,{bold:true});
 txt(s,'3',972,246,250,245,206,{color:C.orange,bold:true});txt(s,'reports to reconcile',933,496,280,90,28,{align:'center'});

 s=page(p,C.ink,'The genuine Operations screenshot was captured after all 24 demo reports were ingested through the API. The capture returned 24 reports, 8 provisional incident groups and 3 unresolved opposing report pairs. The crop focuses on the queue and schematic. All data and locations are synthetic. Source: docs/latex-report/screenshots/dashboard-wide.png and .artifacts-build/capture-state.json.');
 txt(s,'The incident board',48,32,1170,90,66,{bold:true,color:C.white});
 photo(s,'dashboard-wide.png',32,145,890,548,{crop:{left:0,top:0.205,right:0.319,bottom:0},fit:'cover'});
 txt(s,'24',970,137,260,116,92,{bold:true,color:C.orange});txt(s,'reports received',970,252,260,45,25,{color:C.white});
 txt(s,'8',970,328,260,116,92,{bold:true,color:C.orange});txt(s,'provisional groups',970,443,270,45,25,{color:C.white});
 txt(s,'3',970,518,260,116,92,{bold:true,color:C.orange});txt(s,'conflicting pairs',970,631,260,45,25,{color:C.white});

 s=page(p,C.white,'The ordinary form and replay use the same intake path. FastAPI and Pydantic validate inputs. The backend persists the original report with a provisional incident before analysis. The Python engine produces grouping evidence and priority reasons. SQLite stores memberships, review decisions and audit entries. The React and TypeScript frontend displays snapshots and submits version-checked decisions. Source: backend/aegis/api.py, engine.py, storage.py, models.py and frontend/src/.');
 txt(s,'The processing path',56,40,1160,90,66,{bold:true});
 const steps=[['1','Receive','Form or replay','FastAPI + Pydantic'],['2','Preserve','Original text and receipt','SQLite transaction'],['3','Analyse','Matching evidence and priority','Python engine'],['4','Review','Confirm or correct with a reason','React + TypeScript']];
 for(let i=0;i<steps.length;i++){const y=171+i*123;txt(s,steps[i][0],56,y,95,95,64,{bold:true,color:C.orange});txt(s,steps[i][1],168,y+2,320,70,44,{bold:true});txt(s,steps[i][2],548,y+8,665,50,29);txt(s,steps[i][3],550,y+55,665,40,24,{color:C.slate});}

 s=page(p,C.ink,'The native stacked chart shows the configured ranking weights: text 0.65, location 0.20, time 0.10 and category 0.05. Missing score components are omitted and available weights renormalized. Required context still gates attachment. In lexical mode the candidate threshold is 0.33, anchor similarity minimum is 0.05 and candidate margin minimum is 0.08. Known compatible time and specific shared location or entity are required. MiniLM uses separate gates, 0.82 and 0.62, with the same margin. Measured mode is lexical fallback, as actual MiniLM weights were unavailable. Source: backend/aegis/engine.py and evaluation/results/latest.json.');
 txt(s,'Matching',56,30,1170,130,96,{bold:true,color:C.white});txt(s,'Text and event context contribute to the ranking score',62,162,1152,74,31,{color:C.white});
 chartFont(s.charts.add('bar',{position:{left:56,top:263,width:1160,height:176},categories:['Ranking weights'],series:[{name:'Text 65%',values:[0.65],fill:C.orange},{name:'Location 20%',values:[0.20],fill:'#AEB9C0'},{name:'Time 10%',values:[0.10],fill:'#687A86'},{name:'Category 5%',values:[0.05],fill:'#E9EEF1'}],barOptions:{direction:'bar',grouping:'stacked',overlap:100,gapWidth:25},hasLegend:true,legend:{position:'bottom',overlay:false,textStyle:{fontSize:24,fill:C.white}},xAxis:{visible:false},yAxis:{visible:false,min:0,max:1},chartFill:C.ink,plotAreaFill:C.ink,dataLabels:{showValue:false,textStyle:{fontSize:24,fill:C.white}}}));
 const gates=[['0.33','candidate score'],['0.05','anchor similarity'],['0.08','candidate margin']];
 for(let i=0;i<gates.length;i++){const x=60+i*392;txt(s,gates[i][0],x,466,365,105,77,{bold:true,color:C.white});txt(s,gates[i][1],x+2,571,365,46,26,{color:C.gray});}
 txt(s,'Lexical fallback gates. Compatible time and specific shared context are also required.',62,657,1160,38,22,{color:C.gray});

 s=page(p,C.white,'The versioned exercise policy is separate from matching. P0 uses supported affirmative phrases alleging immediate danger. P1 includes blocked exits, medical concerns and supported vulnerable missing-person cases. P2 is a facility issue with a reporter-supplied zone. Unassessed is used when supported information is insufficient. The incident keeps the strongest unresolved signal. The finite English rules have no clinical validation. Source: backend/aegis/engine.py.');
 txt(s,'Priority has an explicit rule',56,40,1160,90,65,{bold:true});
 const rules=[['P0','Affirmative immediate-danger phrase',C.red],['P1','Blocked exit, medical concern or\nvulnerable missing person',C.orange],['P2','Facility issue with a supplied zone',C.ink],['?','Insufficient supported information',C.slate]];
 for(let i=0;i<rules.length;i++){const y=175+i*116;txt(s,rules[i][0],56,y-7,200,100,74,{bold:true,color:rules[i][2]});txt(s,rules[i][1],300,y+8,918,95,31);}
 txt(s,'Unassessed',56,605,210,36,23,{color:C.slate});
 txt(s,'The source phrase stays visible beside the priority suggestion.',300,657,916,38,23,{color:C.slate});

 s=page(p,C.ink,'The real conflict inspector preserves supporting phrases for opposing exit_access values. Blocked and clear are reported values, not verified states. Later reassuring evidence does not automatically close an incident or cancel unresolved urgent evidence. The coordinator can resolve or reopen a conflict with a reason. Source: docs/latex-report/screenshots/conflict-detail.png, backend/aegis/engine.py and storage.py.');
 txt(s,'Conflicting accounts',56,36,1160,88,65,{bold:true,color:C.white});txt(s,'“Blocked”',56,185,650,130,83,{bold:true,color:C.orange});txt(s,'“Clear”',56,321,650,130,83,{bold:true,color:C.white});
 txt(s,'Both accounts remain available.\nThe coordinator reviews the change\nand records a decision.',62,526,650,135,29,{color:C.white});photo(s,'conflict-detail.png',772,142,440,528);

 s=page(p,C.white,'The displayed confirmation form is a genuine screenshot. Grouping actions are confirm, reject, move, merge and split. Mutations require a reason and the versions the coordinator reviewed. Stale edits receive HTTP 409. The quoted reason was entered in the completed confirmation captured in the report audit screenshot. Source: docs/API_CONTRACT.md, backend/aegis/storage.py and screenshots/decision.png and audit.png.');
 txt(s,'The coordinator decides',56,40,1160,90,66,{bold:true});photo(s,'decision.png',48,221,650,282);
 txt(s,'Confirm or reject\nMove, merge or split',766,211,450,128,35,{bold:true});txt(s,'A reason is required.\nStale versions return HTTP 409.',766,403,450,120,29);
 txt(s,'“Reviewed the Exit A accounts together. Keep the changing\ndoor status visible for follow-up.”',62,582,1150,99,28,{bold:true});

 s=page(p,C.white,'Fixtures contain 24 demo reports across 8 families, 60 development reports across 20 families and 60 fixed test/regression reports across 20 families, for 144 reports total. Family labels are separate from runtime inputs. Categories and scenario patterns recur across splits. The test set was inspected during engineering and became a regression benchmark. Source: data/README.md, data/evaluation/ and backend/aegis/evaluation.py.');
 txt(s,'144',48,41,600,230,176,{bold:true,color:C.orange});txt(s,'synthetic reports',60,277,600,74,43,{bold:true});txt(s,'Labels are stored separately\nfrom runtime inputs.',62,439,550,100,30);
 txt(s,'Incident families in parentheses',650,82,568,45,23,{color:C.slate});
 chartFont(s.charts.add('bar',{position:{left:650,top:140,width:568,height:407},categories:['Demo (8 families)','Development (20)','Test/regression (20)'],series:[{name:'Reports',values:[24,60,60],fill:C.ink,points:[{idx:2,fill:C.orange}]}],barOptions:{direction:'bar',grouping:'clustered',gapWidth:85},hasLegend:false,chartFill:C.white,plotAreaFill:C.white,xAxis:{textStyle:{fontSize:24,fill:C.ink},line:{fill:'none',width:0}},yAxis:{min:0,max:65,majorUnit:20,visible:false},dataLabels:{showValue:true,position:'outEnd',textStyle:{fontSize:28,fill:C.ink,bold:true}}}));
 txt(s,'The fixed regression set was inspected during engineering.',62,639,1152,53,24,{color:C.slate});

 s=page(p,C.white,'Saved lexical results on 60 synthetic regression reports: baseline precision 1.0, recall 0.060606, F1 0.114286, 0 false merge pairs and 62 missed pairs. Aegis precision 1.0, recall 0.621212, F1 0.766355, 0 false merge pairs and 25 missed pairs. Of 66 true same-family pairs, Aegis recovers 41 and the baseline 4. All Aegis reports carry review flags. Review rates are based on different method-specific rules. Source: evaluation/results/latest.json.');
 txt(s,'Grouping results',56,36,1160,90,70,{bold:true});txt(s,'60-report synthetic regression set',62,135,1120,50,29,{color:C.slate});
 chartFont(s.charts.add('bar',{position:{left:48,top:219,width:755,height:363},categories:['Recall','F1'],series:[{name:'Jaccard',values:[0.060606,0.114286],fill:'#AEB9C0'},{name:'Aegis lexical',values:[0.621212,0.766355],fill:C.orange}],barOptions:{direction:'column',grouping:'clustered',gapWidth:110},hasLegend:true,legend:{position:'bottom',overlay:false,textStyle:{fontSize:24,fill:C.ink}},chartFill:C.white,plotAreaFill:C.white,xAxis:{textStyle:{fontSize:28,fill:C.ink},line:{fill:'#AEB9C0',width:0.8}},yAxis:{min:0,max:1,majorUnit:0.25,numberFormatCode:'0.00',textStyle:{fontSize:22,fill:C.slate},majorGridlines:{fill:C.mist,width:1}},dataLabels:{showValue:true,position:'outEnd',numberFormatCode:'0.000',textStyle:{fontSize:24,fill:C.ink,bold:true}}}));
 txt(s,'41',903,204,315,180,143,{bold:true,color:C.orange});txt(s,'of 66 same-family\npairs recovered',908,394,306,98,29,{bold:true});txt(s,'Jaccard recovered 4',908,525,306,50,25,{color:C.slate});
 txt(s,'1.000 precision for both methods. Zero observed false merge pairs.',62,615,1155,39,25,{bold:true});txt(s,'Aegis missed 25 pairs. Every Aegis report still carries a review flag.',62,659,1155,38,23,{color:C.slate});

 s=page(p,C.ink,'Recorded verification from 24 October 2026: 196 backend tests and 140 frontend tests passed. Configured coverage measures reached 100%. Lint, formatting, strict TypeScript and production builds passed. Chromium smoke covered replay, intake, grouping confirmation, audit and evaluation with no uncaught browser errors. Coverage measures execution of the included code paths. This refers to the recorded run. Source: docs/VERIFICATION.md and evaluation/results/verification.json.');
 txt(s,'Engineering checks',56,36,1160,90,67,{bold:true,color:C.white});txt(s,'196',46,182,570,240,180,{bold:true,color:C.white});txt(s,'140',668,182,558,240,180,{bold:true,color:C.orange});
 txt(s,'backend tests passed',62,433,540,56,31,{color:C.white});txt(s,'frontend tests passed',683,433,530,56,31,{color:C.white});txt(s,'100% across configured coverage measures',62,565,1150,51,32,{bold:true,color:C.white});txt(s,'Build, types, lint and the full Chromium exercise passed in the recorded run.',62,642,1150,54,24,{color:C.gray});

 s=page(p,C.white,'Matching uses lexical overlap and finite English extraction rules. Actual MiniLM weights were unavailable in the measured environment. Next evaluation needs cached real weights, independently prepared examples and fixed thresholds. User studies should measure coordinator effort and errors. Access control, operational review and real-device accessibility testing remain deployment work. Source: README.md, docs/REPORT.md and docs/REVIEW.md.');
 txt(s,'What comes next',56,36,1160,98,76,{bold:true});const next=[['Model','Measure real MiniLM inference\nand paraphrase coverage.'],['Data','Evaluate on independently\nprepared event reports.'],['Use','Observe coordinators and\nmeasure correction effort.']];
 for(let i=0;i<next.length;i++){const x=60+i*397;txt(s,next[i][0],x,245,364,86,51,{bold:true,color:C.orange});txt(s,next[i][1],x+2,366,364,155,28);}
 txt(s,'Broader use also needs access control, operational review and device testing.',62,635,1150,63,25,{color:C.slate});

 s=page(p,C.orange,'Four-minute demonstration: start a fresh replay, inspect a duplicate family, show changing Exit A accounts, make a correction with a reason, inspect the audit and open evaluation. Keep lexical and synthetic exercise status visible. Source: docs/DEMO.md. Contributors: Ayush Pandey 24BIT0394 and Dheeraj Sutram 24BIT0416.');
 txt(s,'Aegis',48,65,720,215,159,{bold:true});txt(s,'Every accepted report stays available\nfor coordinator review.',58,326,710,117,35,{bold:true});txt(s,'Ayush Pandey  24BIT0394\nDheeraj Sutram  24BIT0416',58,612,720,68,24);
 txt(s,'Live demonstration',855,86,365,116,46,{bold:true});const demo=['1  Receive and group','2  Inspect Exit A','3  Record a correction','4  Open evaluation'];for(let i=0;i<demo.length;i++)txt(s,demo[i],855,270+i*86,366,65,28,{bold:true});
 return {slides:p.slides.items.length};
}
