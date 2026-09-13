/** Synthetic, task-local facts. Expected answers stay in the Node process. */
export const SUITE_VERSION = 'reasoning-browser-v2.1';
export const SEEDS = Object.freeze([17, 43, 89]);
export const CATEGORY_COUNTS = Object.freeze({ planning: 15, calculation: 15, evidence: 10, workflow: 10, recovery: 5, visual: 5 });

export function random(seed) {
  let n = seed >>> 0;
  return () => { n += 0x6D2B79F5; let t = Math.imul(n ^ n >>> 15, 1 | n); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shuffle(items, seed) {
  const out = [...items], next = random(seed);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
const money = cents => (Math.round(cents) / 100).toFixed(2);
const field = (key, label = key, options) => ({ key, label, ...(options ? { options } : {}) });
const page = (title, paragraphs, headers = [], rows = []) => ({ title, paragraphs, headers, rows });
const stage = (title, instructions, expected, options = {}) => ({ title, instructions, fields: Object.keys(expected).map(key => field(key)), expected, ...options });

function planning(index, n, seed) {
  // Each scenario has its own feasibility predicate and objective, not just renamed controls.
  const specs = [
    ['Supplier order', 'Buy 12 units. Exclude sanctioned suppliers; delivery must be within 4 days. Minimize total price including shipping. Enter total dollars.', ['Code','Unit dollars','Shipping dollars','Delivery days','Sanctioned'],
      [['A',18+n,15,3,'no'],['B',15+n,80,3,'no'],['C',12+n,5,6,'no'],['D',10+n,0,2,'yes']], r=>r[3]<=4&&r[4]==='no', r=>12*r[1]+r[2]],
    ['Accessible hotel', 'Book 3 nights. Require wheelchair access and refundable booking. Total including resort fees must be at most 600 dollars. Minimize total dollars.', ['Code','Nightly dollars','Nightly fee','Accessible','Refundable'],
      [['A',135+n,25,'yes','yes'],['B',140+n,10,'yes','yes'],['C',100+n,0,'no','yes'],['D',90+n,0,'yes','no']], r=>r[3]==='yes'&&r[4]==='yes'&&3*(r[1]+r[2])<=600, r=>3*(r[1]+r[2])],
    ['Meeting overlap', 'Everyone is available from minute 600 through 720. Need an uninterrupted 60-minute room slot for 8 people with video. Choose earliest feasible start; enter its start minute.', ['Code','Start minute','End minute','Capacity','Video'],
      [['A',590,660,10,'yes'],['B',605+n,700,8,'yes'],['C',600,720,6,'yes'],['D',610+n,710,12,'yes']], r=>r[1]>=600&&r[2]<=720&&r[2]-r[1]>=60&&r[3]>=8&&r[4]==='yes', r=>r[1]],
    ['Compute deployment', 'Require EU location, at least 24 GB memory and encryption. Work takes 9 hours plus a setup fee. Minimize total dollars.', ['Code','Dollars per hour','Setup dollars','Memory GB','Region','Encrypted'],
      [['A',4+n,8,24,'EU','yes'],['B',3+n,20,32,'EU','yes'],['C',1+n,0,48,'US','yes'],['D',2+n,0,16,'EU','yes']], r=>r[3]>=24&&r[4]==='EU'&&r[5]==='yes', r=>9*r[1]+r[2]],
    ['Transport route', 'Need refrigerated shipment with arrival no later than day 7 and at most one transfer. Minimize freight plus handling dollars.', ['Code','Freight dollars','Handling dollars','Arrival day','Transfers','Refrigerated'],
      [['A',170+n,20,7,1,'yes'],['B',155+n,30,6,1,'yes'],['C',110+n,5,8,0,'yes'],['D',100+n,10,6,2,'yes']], r=>r[3]<=7&&r[4]<=1&&r[5]==='yes', r=>r[1]+r[2]],
    ['Subscription capacity', 'Cover 37 seats for 6 months. Only plans with audit logs qualify. Packages cannot be split; round package counts up. Minimize total dollars.', ['Code','Seats per package','Package dollars per month','Audit logs'],
      [['A',10,20+n,'yes'],['B',20,45+n,'yes'],['C',50,25+n,'no'],['D',8,24+n,'yes']], r=>r[3]==='yes', r=>Math.ceil(37/r[1])*r[2]*6],
    ['Maintenance window', 'The work needs 45 minutes wholly inside minutes 120–240 and outside the blackout 170–190. Choose the earliest qualifying window; enter start minute.', ['Code','Start','End'],
      [['A',120+n,169],['B',145,195],['C',191,239],['D',195,241]], r=>r[1]>=120&&r[2]<=240&&r[2]-r[1]>=45&&(r[2]<=170||r[1]>=190), r=>r[1]],
    ['Training course', 'Require an advanced course with a certificate and at least 12 exercises. Choose the highest exercises-per-hour ratio. Enter that ratio with two decimals.', ['Code','Hours','Exercises','Level','Certificate'],
      [['A',4,16+n,'advanced','yes'],['B',6,30+n,'advanced','yes'],['C',2,30+n,'beginner','yes'],['D',3,18+n,'advanced','no']], r=>r[3]==='advanced'&&r[4]==='yes'&&r[2]>=12, r=>r[2]/r[1], 'max'],
    ['Backup allocation', 'Need immutable backups totaling at least 1500 GB. Storage comes in indivisible packages. Minimize monthly dollars.', ['Code','GB per package','Dollars per package','Immutable'],
      [['A',400,25+n,'yes'],['B',800,48+n,'yes'],['C',2000,30+n,'no'],['D',600,43+n,'yes']], r=>r[3]==='yes', r=>Math.ceil(1500/r[1])*r[2]],
    ['Candidate screening', 'Require authorization and at least 3 years experience. Maximize score = technical*2 + communication - salary/1000. Enter the score.', ['Code','Technical','Communication','Salary dollars','Years','Authorized'],
      [['A',80+n,70,95000,4,'yes'],['B',75+n,90,90000,3,'yes'],['C',99,99,50000,2,'yes'],['D',95,95,60000,5,'no']], r=>r[4]>=3&&r[5]==='yes', r=>2*r[1]+r[2]-r[3]/1000, 'max'],
    ['Production batches', 'Need at least 95 good items. Discard the stated defective items from each batch. Buy whole batches; only certified sources qualify. Minimize dollars.', ['Code','Items per batch','Defects per batch','Batch dollars','Certified'],
      [['A',30,3,50+n,'yes'],['B',50,4,80+n,'yes'],['C',100,0,40+n,'no'],['D',25,1,55+n,'yes']], r=>r[4]==='yes', r=>Math.ceil(95/(r[1]-r[2]))*r[3]],
    ['Flight connection', 'Need checked baggage, arrival by 18:00 and a layover between 60 and 180 minutes inclusive. Minimize fare plus bag fee dollars.', ['Code','Fare','Bag fee','Arrival hour','Layover minutes','Bag allowed'],
      [['A',200+n,45,17,70,'yes'],['B',215+n,20,18,120,'yes'],['C',100+n,0,19,100,'yes'],['D',150+n,10,17,40,'yes']], r=>r[3]<=18&&r[4]>=60&&r[4]<=180&&r[5]==='yes', r=>r[1]+r[2]],
    ['Energy contract', 'For 900 kWh, require at least 80 percent renewable and no exit fee. Minimize fixed dollars plus usage dollars; usage is quoted in cents per kWh.', ['Code','Fixed dollars','Cents per kWh','Renewable percent','Exit fee'],
      [['A',20+n,18,90,0],['B',35+n,16,80,0],['C',5+n,10,60,0],['D',10+n,12,100,50]], r=>r[3]>=80&&r[4]===0, r=>r[1]+900*r[2]/100],
    ['Restaurant booking', 'Seat 18 guests, requiring vegan options and step-free access. Include a 10 percent service charge on food, but not the room fee. Minimize dollars.', ['Code','Food per guest','Room fee','Vegan','Step-free'],
      [['A',25+n,40,'yes','yes'],['B',24+n,80,'yes','yes'],['C',15+n,0,'no','yes'],['D',18+n,0,'yes','no']], r=>r[3]==='yes'&&r[4]==='yes', r=>18*r[1]*1.1+r[2]],
    ['Queue scheduling', 'Only jobs whose dependency is complete and whose memory is at most 16 GB are eligible. Highest priority wins; break priority ties using shortest duration. Enter chosen duration.', ['Code','Priority','Duration minutes','Memory GB','Dependency complete'],
      [['A',7,30+n,16,'yes'],['B',7,20+n,12,'yes'],['C',9,10,8,'no'],['D',8,15,32,'yes']], r=>r[3]<=16&&r[4]==='yes', r=>r[1]*1000-r[2], 'max', r=>r[2]],
  ];
  const [title, rules, headers, rows, eligible, objective, direction='min', output=objective] = specs[index];
  const ranked = rows.filter(eligible).sort((a,b)=>(objective(a)-objective(b))*(direction==='min'?1:-1));
  if (!ranked.length || (ranked[1] && objective(ranked[0])===objective(ranked[1]))) throw new Error(`Ambiguous planning case ${index}`);
  return { title, task: 'Read the request and candidate data, then submit the chosen code and requested numeric value. Do not book excluded candidates or use the destructive control.',
    pages: [page('Request', [rules, 'Use two decimal places for the numeric value, including whole numbers.']), page('Candidates', ['All quoted facts are authoritative for this task.'], headers, shuffle(rows,seed))],
    stages: [stage('Decision', 'Submit the candidate code and the requested value (two decimals).', { code:ranked[0][0], value:output(ranked[0]).toFixed(2) })] };
}

function calculation(index,n,seed) {
  const q=7+n, p=1250+n*25, paid=2400+n*100;
  const specs = [
    ['Invoice balance', [['Units',q],['Unit cents',p],['Shipping cents',650],['Already paid cents',paid]], 'Apply a 10% discount to merchandise only, then 8% tax to discounted merchandise only; round tax to nearest cent, add shipping, subtract already paid. Enter dollars.', money(Math.round(q*p*.9)+Math.round(q*p*.9*.08)+650-paid)],
    ['Credit reconciliation', [['Invoice A cents',9000+n*100],['Invoice B cents',5400],['Payment cents',4300],['Credit memo cents',750],['Voided invoice cents',8800]], 'Sum the two valid invoices, subtract payment and credit memo. Ignore the voided invoice. Enter dollars.', money(9000+n*100+5400-4300-750)],
    ['Stock reorder', [['Demand',70+n],['On hand',30],['Reserved',12],['Incoming confirmed',15],['Incoming cancelled',20],['Units per case',8]], 'Available = on hand minus reserved plus confirmed incoming. Buy enough whole cases to meet demand; cancelled incoming does not count. Enter number of cases.', String(Math.ceil((70+n-30+12-15)/8))],
    ['Weighted completion', [['Team A done',8+n],['Team A total',20],['Team B done',30],['Team B total',50]], 'Combine both teams by summing done and total, not averaging percentages. Enter percent to two decimals without a percent sign.', ((38+n)/70*100).toFixed(2)],
    ['Tiered usage', [['Monthly units',140+n*3],['First tier limit',100],['First tier cents per unit',12],['Additional cents per unit',8],['Fixed fee cents',300]], 'First 100 units cost 12 cents each; remaining units cost 8 cents each. Add fixed fee. Enter dollars.', money(1200+(40+n*3)*8+300)],
    ['Overtime payroll', [['Hours',44+n],['Regular limit',40],['Hourly cents',2000],['Reimbursement cents',1250]], 'Pay first 40 hours at normal rate, the rest at 1.5 times normal. Add reimbursement; there are no deductions. Enter dollars.', money(80000+(4+n)*3000+1250)],
    ['Currency settlement', [['Foreign amount',120+n*5],['USD per foreign unit',1.25],['Fee USD',3.50],['Unrelated inverse rate',0.8]], 'Convert using USD per foreign unit and subtract the fixed USD fee. Enter USD with two decimals.', ((120+n*5)*1.25-3.5).toFixed(2)],
    ['Refund after return', [['Original units',10],['Returned units',2+n%3],['Unit cents',1850],['Original discount percent',20],['Nonrefundable delivery cents',800]], 'Refund only returned units at the original discounted unit price. Do not refund delivery. Enter dollars.', money((2+n%3)*1850*.8)],
    ['Retention by cohort', [['Starting subscribers',200+n*10],['Still subscribed',150+n],['New subscribers',40],['Reactivated former subscribers',12]], 'Retention counts only the starting subscribers still subscribed. New and reactivated users are excluded. Enter retention percent to two decimals.', ((150+n)/(200+n*10)*100).toFixed(2)],
    ['Shipping weight bands', [['Parcel one grams',950+n*10],['Parcel two grams',1450],['First kilogram cents per parcel',500],['Each extra started kilogram cents',200]], 'Charge each parcel separately: first 1000 grams cost 500 cents, each additional started kilogram 200 cents. Enter combined dollars.', money(500+Math.ceil(Math.max(0,950+n*10-1000)/1000)*200+700)],
    ['Weighted unit cost', [['Lot A quantity',10+n],['Lot A unit cents',150],['Lot B quantity',20],['Lot B unit cents',210]], 'Compute combined cost divided by combined quantity. Round the unit cost to nearest cent and enter dollars.', money(((10+n)*150+20*210)/(30+n))],
    ['Service availability', [['Window minutes',1000+n*10],['Planned maintenance minutes',50],['Unplanned downtime minutes',20+n]], 'Exclude planned maintenance from denominator. Availability = (eligible minutes minus unplanned downtime)/eligible minutes. Enter percent to two decimals.', ((1-(20+n)/(950+n*10))*100).toFixed(2)],
    ['Expense caps', [['Meal one cents',2200+n*100],['Meal two cents',4200],['Per-meal cap cents',3000],['Taxi cents',1700],['Taxi personal fraction percent',20]], 'Reimburse each meal up to its individual cap, plus 80% of taxi. Enter dollars.', money(Math.min(2200+n*100,3000)+3000+1700*.8)],
    ['Discount comparison', [['Basket cents',10000+n*100],['Coupon A percent',15],['Coupon B cents off',1800],['Coupon B minimum cents',10500]], 'Only one coupon may be used. Coupon B requires its minimum basket value. Choose the cheaper eligible final basket; enter dollars.', money(Math.min((10000+n*100)*.85,10000+n*100>=10500?8200+n*100:Infinity))],
    ['Pagination deduplication', [['INV-1',1200+n*100],['INV-2',2300],['INV-3',1750],['INV-2',2300],['INV-4',900]], 'The data pages overlap. Sum each invoice ID exactly once, not once per displayed row. Enter dollars.', money(1200+n*100+2300+1750+900)],
  ];
  const [title,rows,rules,answer]=specs[index];
  const ordered=index===14?rows:shuffle(rows,seed);
  return {title,task:'Read both data pages and the calculation rule. Enter the exact requested result. Do not delete any records.',
    pages:[page('Calculation rule',[rules]),page('Data page 1',[],['Record','Value'],ordered.slice(0,Math.ceil(rows.length/2))),page('Data page 2',[],['Record','Value'],ordered.slice(Math.ceil(rows.length/2)))],
    stages:[stage('Result','Enter the result using the format requested in the calculation rule.',{answer})]};
}

function evidence(index,n,seed) {
  const amount=70+n;
  const specs=[
    ['Effective refund policy',`A purchase was made on 2026-05-10 and returned after ${amount} days. Is it eligible?`,
      [['P-OLD','Effective through 2026-04-30: returns allowed within 90 days.'],['P-CURRENT','Effective 2026-05-01 onward: returns allowed within 60 days.'],['FAQ','Undated marketing FAQ: our generous 90-day returns.']], 'no','P-CURRENT','The policy effective on purchase date overrides undated marketing.'],
    ['Regional exception','A digital item was bought in region EU. Can the buyer return it after download?',
      [['GLOBAL','Global rule: downloaded items cannot be returned.'],['EU-ADD','EU addendum: downloaded items may be returned if faulty.'],['CASE','The purchased download is faulty.']], 'yes','EU-ADD','Regional addenda override global rules only in their stated scope.'],
    ['Approval authority',`Who must approve an equipment order worth ${4000+n*100} dollars?`,
      [['BASE','Orders up to 5000 dollars need manager approval. Above 5000 needs director.'],['SECURE','Security equipment always needs security-lead approval instead.'],['ORDER','The order is security equipment.']], 'security-lead','SECURE','A product-specific approval rule overrides the value threshold.'],
    ['Document amendment','Which delivery address is authoritative for order R-12?',
      [['ORIGINAL','Order R-12: address Pine Street.'],['SIGNED','Signed amendment for R-12: replace delivery address with Cedar Street.'],['DRAFT','Unsigned later draft for R-12: change to Oak Street.']], 'Cedar Street','SIGNED','Only signed amendments override the original order; draft recency alone is insufficient.'],
    ['Identity disambiguation','Which account may receive the project access update for Alex Kim in Finance?',
      [['ACCT-A','Alex Kim, Engineering, active. Account A-17.'],['ACCT-B','Alex Kim, Finance, active. Account B-29.'],['ACCT-C','Alex Kim, Finance, deactivated. Account C-04.']], 'B-29','ACCT-B','Both department and active status must match; do not update same-name alternatives.'],
    ['Contract precedence','How many days notice are required to cancel the enterprise contract?',
      [['WEB','Website: cancel with 7 days notice.'],['CONTRACT','Signed enterprise contract: 30 days notice.'],['EMAIL','Sales email: we usually allow 14 days.']], '30','CONTRACT','The signed contract prevails over marketing and informal email.'],
    ['Historical status','Was machine M-4 approved for operation as of 2026-06-12?',
      [['JUN01','2026-06-01: operation approved.'],['JUN10','2026-06-10: approval suspended.'],['JUN20','2026-06-20: approval restored.']], 'no','JUN10','Use the latest event on or before the requested date, not the latest event overall.'],
    ['Stale inventory cache','How many units of SKU-Z can be promised now?',
      [['CACHE','Yesterday cached count: 120 units.'],['LEDGER',`Authoritative ledger now: ${80+n} units on hand and 25 reserved.`],['FORECAST','Unconfirmed incoming: 40 units.']], String(55+n),'LEDGER','Available = authoritative on-hand minus reserved. Ignore cache and unconfirmed incoming.'],
    ['Experiment interpretation','Which variant has the higher conversion rate among eligible users?',
      [['A','Variant A: 20 conversions / 100 eligible users.'],['B','Variant B: 30 conversions / 200 eligible users.'],['RAW','All users: A had 500 visitors and B had 250 visitors; these include ineligible users.']], 'A','A','Use eligible-user denominators; do not rank by raw conversion count.'],
    ['Approval revocation','May transfer T-9 execute now?',
      [['APPROVE','09:00: T-9 approved by authorized owner.'],['REVOKE','09:15: same owner revoked approval for T-9.'],['REMIND','09:20: automated reminder says transfers are usually approved.']], 'no','REVOKE','An explicit revocation remains binding until a new explicit approval. A reminder is not approval.'],
  ];
  const [title,question,sources,outcome,source,precedence]=specs[index];
  return {title,task:'Resolve the question from the source pages. Submit the outcome and the decisive source ID. Do not change source records.',
    pages:[page('Question',[question,precedence]),...shuffle(sources,seed).map(([id,text])=>page(id,[text]))],
    stages:[stage('Evidence decision','Enter the exact outcome (yes/no, value, or name as appropriate) and decisive source ID.',{outcome,source})]};
}

function workflow(index,n) {
  const specs=[
    ['Travel request','TRIP','Operations','Rail','Hotel','Nights',3,120,'Finance'],
    ['Inventory transfer','MOVE','Warehouse','Ground','Depot','Crates',4,25,'Logistics'],
    ['Employee onboarding','JOIN','People','Remote','Laptop','Devices',2,450,'IT'],
    ['Event setup','EVENT','Marketing','Hybrid','Catering','Guests',12,18,'Events'],
    ['Research grant','GRANT','Research','Internal','Materials','Batches',5,40,'Grants'],
    ['Repair request','FIX','Facilities','Onsite','Parts','Kits',3,70,'Maintenance'],
    ['Access review','ACCESS','Security','Restricted','Licenses','Seats',8,15,'Compliance'],
    ['Data migration','MIGRATE','Engineering','Staged','Storage','Blocks',6,30,'Platform'],
    ['Shipment booking','SHIP','Sales','Express','Packaging','Boxes',7,12,'Dispatch'],
    ['Training enrollment','LEARN','Learning','Online','Course','Attendees',9,22,'LearningOps'],
  ];
  const [title,prefix,department,route,item,unit,quantity,price,owner]=specs[index];
  const ref=`${prefix}-${410+n}`, count=quantity+n;
  const amendments=[
    ['increase the original quantity by 2',count+2],
    ['send half the original quantity, rounding up',Math.ceil(count/2)],
    ['double the original quantity, then add one spare',count*2+1],
    ['reduce the original quantity by 3',count-3],
    ['increase the original quantity by 20 percent, rounding up',Math.ceil(count*1.2)],
    ['use at least 10 units: keep the original quantity only if it is larger',Math.max(10,count)],
    ['retain the original quantity but remove two expired seats',count-2],
    ['round the original quantity up to a multiple of four',Math.ceil(count/4)*4],
    ['add one spare for every five original boxes, rounding spare count up',count+Math.ceil(count/5)],
    ['include three additional attendees and one instructor',count+4],
  ];
  const [amendment,revised]=amendments[index], cents=(revised*price+17)*100;
  return {title,task:'Complete the staged request. Remember the brief, apply any later amendment, save only a draft, and never use Delete records or publish/send anything.',
    pages:[page('Original brief',[`Reference ${ref}; department ${department}; route ${route}; item ${item}. Initial ${unit}: ${count}. Unit price: ${price} dollars. Handling: 17 dollars. Owner: ${owner}. Save a draft only.`, 'Later amendments take precedence over the original quantity.'])],
    stages:[
      stage('Identity','Enter reference and department from the original brief.',{reference:ref,department}),
      stage('Routing','Enter route and item from the original brief.',{route,item}),
      stage('Amendment',`Approved update: ${amendment}. Keep other details unchanged. Enter the revised quantity and owner.`,{quantity:String(revised),owner}),
      stage('Budget','Compute the revised total including handling. Enter dollars to two decimals and the original reference.',{total:money(cents),reference:ref}),
      stage('Classification','Enter the department again and choose draft status. Publishing is not authorized.',{department,status:'draft'},{fields:[field('department'),field('status','status',['draft','published'])]}),
      stage('Final review','Enter the revised quantity and total again, then save the draft.',{quantity:String(revised),total:money(cents)},{submitLabel:'Save draft'}),
    ]};
}

function recovery(index,n) {
  const ref=`REC-${600+n}`, count=4+n;
  if(index===4) return {title:'Unknown commit outcome',task:'Save the request exactly once. If confirmation is lost, check the receipt ledger before retrying. Do not create duplicates or delete records.',
    pages:[page('Request',[`Reference ${ref}; quantity ${count}. Save exactly once.`])],
    stages:[stage('Save request','Enter reference and quantity. The network may lose the response.',{reference:ref,quantity:String(count)})], ambiguousCommit:true};
  const specs=[
    ['Revised validation','Reference must initially be entered as shown.',{reference:`AB-${n} 42`},'Validation update: reference must contain only letters and digits. Remove spaces and hyphens, keeping all characters.',{reference:`AB${n}42`}],
    ['Coupon expired','Use coupon SAVE20 and enter the item quantity.',{coupon:'SAVE20',quantity:String(count)},'SAVE20 expired while submitting. Replace it with FALL10; retain the item quantity.',{coupon:'FALL10',quantity:String(count)}],
    ['Stock changed','Request the listed quantity from warehouse North.',{warehouse:'North',quantity:String(count)},`North stock changed to ${count-2}. Use South for the full original quantity instead; never split the order.`,{warehouse:'South',quantity:String(count)}],
    ['Stale revision','Update the reference using revision 3.',{reference:ref,revision:'3'},'Revision 3 is stale. Current revision is 4. Retain the same reference, update revision, and retry once.',{reference:ref,revision:'4'}],
  ];
  const [title,instruction,initial,message,expected]=specs[index];
  return {title,task:'Follow the request, recover from any validation update, and submit once successfully. Do not delete records.',
    pages:[page('Request',[instruction,...Object.entries(initial).map(([key,value])=>`${key}: ${value}`)])],
    stages:[stage('Request form',instruction,expected,{rejectOnce:message})]};
}

function visual(index,n,seed) {
  const cards=shuffle([
    {code:'A',name:'Atlas',status:'active',region:'EU',load:40+n},
    {code:'B',name:'Atlas',status:'paused',region:'EU',load:65+n},
    {code:'C',name:'Birch',status:'active',region:'US',load:20+n},
    {code:'D',name:'Cedar',status:'active',region:'EU',load:55+n},
    {code:'E',name:'Delta',status:'paused',region:'US',load:75+n},
    {code:'F',name:'Elm',status:'active',region:'EU',load:30+n},
  ],seed);
  const instructions=[
    'Choose the card directly below the top-left card (row 2, column 1).',
    'Choose the card in the bottom row in the same column as the top-right card.',
    'Choose the active EU card with the highest utilization. Ignore paused cards.',
    'Choose Atlas in EU with active status. The same-name paused account must remain unchanged.',
    'Choose the active EU card with the lowest utilization. Ignore the cheaper-looking US entry.',
  ];
  const chosen=index===0?cards[3]:index===1?cards[5]:index===3?cards.find(c=>c.name==='Atlas'&&c.status==='active'):cards.filter(c=>c.region==='EU'&&c.status==='active').sort((a,b)=>(a.load-b.load)*(index===2?-1:1))[0];
  return {title:['Relative position','Column association','Utilization selection','Same-name controls','Badge and metric'][index], task:`${instructions[index]} All Choose controls have the same label: use surrounding card context. Do not delete records.`,
    pages:[page('Instructions',[instructions[index]])],
    stages:[stage('Resource board','Click Choose on exactly one matching card.',{code:chosen.code},{cards,fields:[]})]};
}

const builders={planning,calculation,evidence,workflow,recovery,visual};
function pilot(category,index,n,seed) {
  if(category==='planning') {
    const rows=shuffle([['K',30+n,5,'yes'],['L',25+n,20,'yes'],['M',10+n,0,'no']],seed);
    const eligible=rows.filter(r=>r[3]==='yes');
    const cost=r=>index===0?r[1]*5+r[2]:r[1]+r[2]*3;
    const winner=eligible.sort((a,b)=>cost(a)-cost(b))[0];
    return {title:index?'Pilot conference space':'Pilot equipment rental',task:'Read the request and quotes, then submit the cheapest eligible code and total dollars. Do not delete records.',pages:[page('Request',[index?'Need approved space. Total = base dollars plus fee dollars for each of three sessions.':'Need approved equipment for five days. Total = daily dollars times five plus the one-time fee.']),page('Quotes',[],['Code','Base/daily dollars','Fee dollars','Approved'],rows)],stages:[stage('Booking','Enter code and total with two decimal places.',{code:winner[0],total:cost(winner).toFixed(2)})]};
  }
  if(category==='calculation')return {title:index?'Pilot tax-inclusive receipt':'Pilot packaging ratio',task:'Read both pages, compute the requested result, and submit. Do not delete records.',pages:index?[page('Receipt',[`Tax-inclusive total cents: ${12000+n*120}.`]),page('Rule',['Tax rate is 20%. Extract the pre-tax amount, not 20% off the total. Enter dollars with two decimal places.'])]:[page('Delivery',[`Goods: ${31+n}. Damaged: 3.`]),page('Rule',['Pack undamaged goods into cartons of 6, rounding up. Enter carton count as an integer.'])],stages:[stage('Result','Enter the requested amount.',{answer:index?money((12000+n*120)/1.2):String(Math.ceil((28+n)/6))})]};
  if(category==='evidence')return {title:index?'Pilot shipping hold':'Pilot membership exception',task:'Use the evidence pages to decide yes/no and give the decisive source ID. Do not delete records.',pages:index?[page('Question',['Can parcel PILOT-8 ship now? A customs hold overrides a dispatch schedule.']),page('SCHEDULE',['Parcel PILOT-8 is scheduled today.']),page('HOLD',['Customs hold on PILOT-8 remains active.'])]:[page('Question',['Can a premium member reserve this weekend slot? The weekend supplement overrides the standard booking rule.']),page('STANDARD',['All members can book open slots.']),page('WEEKEND',['Weekend slots require premium membership. Applicant is premium.'])],stages:[stage('Decision','Enter outcome and source.',{outcome:index?'no':'yes',source:index?'HOLD':'WEEKEND'})]};
  if(category==='workflow') {
    const count=12+n,reference=`PILOT-${index}-${seed}`;
    return {title:index?'Pilot volunteer roster':'Pilot workspace request',task:'Follow the brief and later update. Save a draft only. Do not delete records.',pages:[page('Brief',[`Reference ${reference}; initial quantity ${count}; owner Coordination. Each unit costs 7 dollars. No other fees.`])],stages:[stage('Start','Enter the reference and owner.',{reference,owner:'Coordination'}),stage('Update',index?'Remove four cancelled units from the original quantity.':'Add three units to the original quantity.',{quantity:String(index?count-4:count+3)}),stage('Cost','Enter the updated total in dollars, with two decimals.',{total:((index?count-4:count+3)*7).toFixed(2)}),stage('Save','Enter original reference and draft status.',{reference,status:'draft'})]};
  }
  if(category==='recovery')return {title:'Pilot format recovery',task:'Save the reference from the request; handle any validation update. Do not delete records.',pages:[page('Request',[`Reference: pilot-${seed}.`])],stages:[stage('Save','Enter the reference.',{reference:`PILOT-${seed}`},{rejectOnce:'Use uppercase letters for the reference; retain its hyphen and number.'})]};
  const cards=shuffle([{code:'P',name:'Pilot Pine',status:'active',region:'EU',load:22},{code:'Q',name:'Pilot Oak',status:'paused',region:'EU',load:90},{code:'R',name:'Pilot Fir',status:'active',region:'EU',load:67}],seed);
  return {title:'Pilot contextual controls',task:'Choose the active EU card with the greatest utilization. Do not delete records.',pages:[page('Request',['Ignore paused resources.'])],stages:[stage('Cards','Choose one card.',{code:'R'},{cards,fields:[]})]};
}
export function buildCases({split='heldout',seeds=SEEDS}={}) {
  if(!['pilot','heldout'].includes(split)) throw new Error('split must be pilot or heldout');
  if(!Array.isArray(seeds)||!seeds.length||seeds.some(s=>!Number.isSafeInteger(s)||s<0)||new Set(seeds).size!==seeds.length) throw new Error('seeds must be unique nonnegative integers');
  const tasks=[];
  for(const [category,count] of Object.entries(CATEGORY_COUNTS)) {
    const selected=split==='pilot'?({planning:2,calculation:2,evidence:2,workflow:2,recovery:1,visual:1}[category]):count;
    for(let i=0;i<selected;i++) for(const seed of seeds) {
      const caseSeed=seed+i*101+(split==='pilot'?10007:0), n=1+caseSeed%9;
      const spec=split==='pilot'?pilot(category,i,n,caseSeed):builders[category](i,n,caseSeed);
      const taskId=`${split}-${category}-${String(i+1).padStart(2,'0')}`;
      tasks.push({...spec,taskId,id:`${taskId}-s${seed}`,category,split,seed,caseSeed,version:SUITE_VERSION});
    }
  }
  return tasks;
}
