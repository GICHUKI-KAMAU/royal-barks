from __future__ import annotations

import json
import hashlib
import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = Path(os.environ.get("ROYAL_BARKS_DB", ROOT / "backend" / "data" / "royal_barks.sqlite3"))
STATUSES = ("ACTIVE", "DORMANT", "STATUS TO CONFIRM")
REFERENCE = {
    "paid_monthly": 206300, "paid_penalty": 24850, "paid_savings_500": 95200,
    "paid_food": 98500, "total_paid": 415650, "unpaid_monthly": 171100,
    "unpaid_penalty": 45400, "total_unpaid": 216500, "cash": 79732.70,
}

@contextmanager
def db_session():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def audit(db, event: str, actor: str, entity: str, entity_id: int | None, details: dict):
    db.execute("INSERT INTO audit_log(event,actor,entity,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
               (event, actor, entity, entity_id, json.dumps(details), timestamp()))

def status_on(db, member_id: int, on_date: str) -> str:
    row = db.execute("SELECT new_status FROM status_history WHERE member_id=? AND effective_date<=? ORDER BY effective_date DESC,id DESC LIMIT 1", (member_id, on_date)).fetchone()
    return row["new_status"] if row else "STATUS TO CONFIRM"

def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_session() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, status TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS status_history(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), previous_status TEXT NOT NULL, new_status TEXT NOT NULL, effective_date TEXT NOT NULL, reason TEXT NOT NULL, official TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS obligations(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), category TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0), obligation_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', source_key TEXT UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), category TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0), transaction_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', source_key TEXT UNIQUE, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meetings(id INTEGER PRIMARY KEY, meeting_date TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id), member_id INTEGER NOT NULL REFERENCES members(id), attended INTEGER NOT NULL CHECK(attended IN (0,1)), UNIQUE(meeting_id,member_id));
        CREATE TABLE IF NOT EXISTS imports(id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, statement_date TEXT NOT NULL, source TEXT NOT NULL, imported_by TEXT NOT NULL, reviewed_by TEXT, approved_by TEXT, status TEXT NOT NULL, reference_json TEXT NOT NULL, reconciliation_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS import_rows(id INTEGER PRIMARY KEY, import_id INTEGER NOT NULL REFERENCES imports(id), member_name TEXT NOT NULL, existing_status TEXT NOT NULL, amounts_json TEXT NOT NULL, verification_status TEXT NOT NULL, issues_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS opening_balances(id INTEGER PRIMARY KEY, import_row_id INTEGER NOT NULL REFERENCES import_rows(id), member_id INTEGER NOT NULL REFERENCES members(id), category TEXT NOT NULL, amount REAL NOT NULL, balance_type TEXT NOT NULL, statement_date TEXT NOT NULL, source TEXT NOT NULL, UNIQUE(import_row_id,category,balance_type));
        CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, event TEXT NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
        """)

app = FastAPI(title="Royal Barks Finance API", version="0.1.0", lifespan=None)
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

class MemberIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    status: Literal["ACTIVE", "DORMANT", "STATUS TO CONFIRM"] = "STATUS TO CONFIRM"
    effective_date: date
    reason: str = Field(min_length=2, max_length=500)
    official: str = Field(min_length=2, max_length=160)
    confirmed: bool = False

class StatusIn(BaseModel):
    new_status: Literal["ACTIVE", "DORMANT", "STATUS TO CONFIRM"]
    effective_date: date
    reason: str = Field(min_length=2, max_length=500)
    official: str = Field(min_length=2, max_length=160)
    confirmed: bool = False

class ObligationIn(BaseModel):
    member_id: int
    category: Literal["monthly", "meeting", "penalty", "food", "other"]
    amount: float = Field(gt=0)
    obligation_date: date
    note: str = ""
    official: str = Field(min_length=2, max_length=160)
    food_rule_confirmed: bool = False
    source_key: str | None = None

class PaymentIn(BaseModel):
    member_id: int
    category: Literal["monthly", "meeting", "penalty", "savings_500", "food", "other"]
    amount: float = Field(gt=0)
    transaction_date: date
    note: str = ""
    official: str = Field(min_length=2, max_length=160)
    source_key: str | None = None

class MonthlyBatchIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    amount: float = Field(gt=0)
    official: str = Field(min_length=2, max_length=160)

class MeetingIn(BaseModel):
    meeting_date: date
    title: str = "Member meeting"
    official: str = Field(min_length=2, max_length=160)
    contribution: Literal[500] = 500
    attendance: dict[int, bool] = {}

class ImportIn(BaseModel):
    statement_date: date
    source: str = Field(min_length=1, max_length=300)
    imported_by: str = Field(min_length=2, max_length=160)
    reviewed_by: str = Field(min_length=2, max_length=160)
    approved_by: str = Field(min_length=2, max_length=160)
    rows: list[dict]
    confirmed: bool = False

@app.on_event("startup")
def startup(): initialize()

@app.get("/api/health")
def health(): return {"status": "ok"}

@app.get("/api/dashboard")
def dashboard():
    with db_session() as db:
        members = {s: db.execute("SELECT COUNT(*) n FROM members WHERE status=?", (s,)).fetchone()["n"] for s in STATUSES}
        paid = db.execute("SELECT COALESCE(SUM(amount),0) n FROM transactions").fetchone()["n"]
        obligations = db.execute("SELECT COALESCE(SUM(amount),0) n FROM obligations").fetchone()["n"]
        arrears = db.execute("SELECT COALESCE(SUM(amount),0) n FROM opening_balances WHERE balance_type='opening_arrears'").fetchone()["n"]
        return {"members": {"active": members["ACTIVE"], "dormant": members["DORMANT"], "confirm": members["STATUS TO CONFIRM"], "total": sum(members.values())}, "new_paid": round(paid,2), "new_obligations": round(obligations,2), "opening_arrears": round(arrears,2), "reference": REFERENCE}

@app.get("/api/members")
def members():
    with db_session() as db:
        out = []
        for m in db.execute("SELECT * FROM members ORDER BY name COLLATE NOCASE"):
            mid = m["id"]
            paid = db.execute("SELECT category,SUM(amount) n FROM transactions WHERE member_id=? GROUP BY category",(mid,)).fetchall()
            due = db.execute("SELECT category,SUM(amount) n FROM obligations WHERE member_id=? GROUP BY category",(mid,)).fetchall()
            openings = db.execute("SELECT category,balance_type,SUM(amount) n FROM opening_balances WHERE member_id=? GROUP BY category,balance_type",(mid,)).fetchall()
            p={x["category"]:x["n"] for x in paid}; o={x["category"]:x["n"] for x in due}; hist={}; arrears={}
            for x in openings:
                (hist if x["balance_type"]=="paid_historical" else arrears)[x["category"]]=x["n"]
            cats=set(p)|set(o)|set(hist)|set(arrears)
            out.append({**dict(m),"categories":{c:{"paid_new":p.get(c,0),"obligations_new":o.get(c,0),"historical_paid":hist.get(c,0),"opening_arrears":arrears.get(c,0),"current_due":round(arrears.get(c,0)+o.get(c,0)-p.get(c,0),2)} for c in cats},"status_history":[dict(x) for x in db.execute("SELECT previous_status,new_status,effective_date,reason,official,created_at FROM status_history WHERE member_id=? ORDER BY effective_date,id",(mid,))]} )
        return out

@app.post("/api/members", status_code=201)
def create_member(item: MemberIn):
    if item.status != "STATUS TO CONFIRM" and not item.confirmed: raise HTTPException(400,"Confirm the initial active or dormant status before saving.")
    with db_session() as db:
        try:
            cur=db.execute("INSERT INTO members(name,status,created_at) VALUES(?,?,?)",(item.name.strip(),item.status,timestamp()))
        except sqlite3.IntegrityError: raise HTTPException(409,"A member with this name already exists.")
        mid=cur.lastrowid
        db.execute("INSERT INTO status_history(member_id,previous_status,new_status,effective_date,reason,official,created_at) VALUES(?,?,?,?,?,?,?)",(mid,"NONE",item.status,item.effective_date.isoformat(),item.reason,item.official,timestamp()))
        db.execute("UPDATE members SET status=? WHERE id=?",(status_on(db,mid,date.today().isoformat()),mid))
        audit(db,"member_created",item.official,"member",mid,{"name":item.name,"status":item.status})
        return {"id":mid}

@app.get("/api/members/{member_id}/status-preview")
def status_preview(member_id: int, new_status: str, effective_date: date):
    with db_session() as db:
        member=db.execute("SELECT * FROM members WHERE id=?",(member_id,)).fetchone()
        if not member: raise HTTPException(404,"Member not found.")
        existing=db.execute("SELECT COUNT(*) n,COALESCE(SUM(amount),0) total FROM obligations WHERE member_id=? AND category IN ('monthly','meeting') AND obligation_date>=?",(member_id,effective_date.isoformat())).fetchone()
        arrears=db.execute("SELECT COALESCE(SUM(amount),0) n FROM opening_balances WHERE member_id=? AND balance_type='opening_arrears'",(member_id,)).fetchone()["n"]
        return {"current_status_on_date":status_on(db,member_id,effective_date.isoformat()),"proposed_status":new_status,"effective_date":effective_date.isoformat(),"opening_arrears":arrears,"existing_future_obligations":existing["n"],"existing_future_obligation_amount":existing["total"],"historical_balances_preserved":True,"dormant_period_charges_generated":False}

@app.post("/api/members/{member_id}/status")
def change_status(member_id: int,item: StatusIn):
    if not item.confirmed: raise HTTPException(400,"Confirm the status change after reviewing its financial impact.")
    with db_session() as db:
        member=db.execute("SELECT * FROM members WHERE id=?",(member_id,)).fetchone()
        if not member: raise HTTPException(404,"Member not found.")
        old=status_on(db,member_id,item.effective_date.isoformat())
        db.execute("INSERT INTO status_history(member_id,previous_status,new_status,effective_date,reason,official,created_at) VALUES(?,?,?,?,?,?,?)",(member_id,old,item.new_status,item.effective_date.isoformat(),item.reason,item.official,timestamp()))
        db.execute("UPDATE members SET status=? WHERE id=?",(status_on(db,member_id,date.today().isoformat()),member_id))
        audit(db,"member_status_changed",item.official,"member",member_id,{"previous":old,"new":item.new_status,"effective_date":item.effective_date.isoformat(),"reason":item.reason})
        return {"ok":True}

@app.post("/api/obligations/monthly")
def monthly_batch(item: MonthlyBatchIn):
    y,m=map(int,item.month.split("-")); obligation_day=date(y,m,1).isoformat()
    with db_session() as db:
        members=db.execute("SELECT id FROM members").fetchall(); created=0
        for row in members:
            mid=row["id"]
            if status_on(db,mid,obligation_day)!="ACTIVE": continue
            key=f"monthly:{mid}:{item.month}"
            cur=db.execute("INSERT OR IGNORE INTO obligations(member_id,category,amount,obligation_date,note,source_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",(mid,"monthly",item.amount,obligation_day,item.month,key,item.official,timestamp()))
            created+=cur.rowcount
        audit(db,"monthly_obligations_generated",item.official,"monthly_batch",None,{"month":item.month,"amount":item.amount,"created":created})
        return {"created":created,"month":item.month}

@app.post("/api/obligations",status_code=201)
def create_obligation(item: ObligationIn):
    if item.category=="food" and not item.food_rule_confirmed: raise HTTPException(400,"Confirm the approved food eligibility rule before recording a food obligation.")
    if item.category=="meeting" and item.amount!=500: raise HTTPException(400,"The meeting contribution is fixed at KSh 500.")
    with db_session() as db:
        member=db.execute("SELECT id FROM members WHERE id=?",(item.member_id,)).fetchone()
        if not member: raise HTTPException(404,"Member not found.")
        if item.category in ("monthly","meeting") and status_on(db,item.member_id,item.obligation_date.isoformat())!="ACTIVE": raise HTTPException(400,"Monthly and KSh 500 obligations can only be recorded for an active member on that date.")
        try:
            cur=db.execute("INSERT INTO obligations(member_id,category,amount,obligation_date,note,source_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",(item.member_id,item.category,item.amount,item.obligation_date.isoformat(),item.note,item.source_key,item.official,timestamp()))
        except sqlite3.IntegrityError: raise HTTPException(409,"Duplicate financial entry.")
        audit(db,"obligation_recorded",item.official,"obligation",cur.lastrowid,{"category":item.category,"amount":item.amount})
        return {"id":cur.lastrowid}

@app.post("/api/payments",status_code=201)
def create_payment(item: PaymentIn):
    with db_session() as db:
        if not db.execute("SELECT 1 FROM members WHERE id=?",(item.member_id,)).fetchone(): raise HTTPException(404,"Member not found.")
        try: cur=db.execute("INSERT INTO transactions(member_id,category,amount,transaction_date,note,source_key,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?)",(item.member_id,item.category,item.amount,item.transaction_date.isoformat(),item.note,item.source_key,item.official,timestamp()))
        except sqlite3.IntegrityError: raise HTTPException(409,"Duplicate financial entry.")
        audit(db,"payment_recorded",item.official,"transaction",cur.lastrowid,{"category":item.category,"amount":item.amount})
        return {"id":cur.lastrowid}

@app.post("/api/meetings",status_code=201)
def create_meeting(item: MeetingIn):
    with db_session() as db:
        try: cur=db.execute("INSERT INTO meetings(meeting_date,title,created_by,created_at) VALUES(?,?,?,?)",(item.meeting_date.isoformat(),item.title,item.official,timestamp()))
        except sqlite3.IntegrityError: raise HTTPException(409,"A meeting is already recorded for this date.")
        meeting_id=cur.lastrowid; created=0
        for row in db.execute("SELECT id FROM members").fetchall():
            mid=row["id"]; db.execute("INSERT OR IGNORE INTO attendance(meeting_id,member_id,attended) VALUES(?,?,?)",(meeting_id,mid,int(item.attendance.get(mid,False))))
            if status_on(db,mid,item.meeting_date.isoformat())=="ACTIVE":
                db.execute("INSERT OR IGNORE INTO obligations(member_id,category,amount,obligation_date,note,source_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",(mid,"meeting",item.contribution,item.meeting_date.isoformat(),item.title,f"meeting:{meeting_id}:member:{mid}",item.official,timestamp())); created+=1
        audit(db,"meeting_created",item.official,"meeting",meeting_id,{"date":item.meeting_date.isoformat(),"contribution_obligations":created})
        return {"id":meeting_id,"contribution_obligations":created}

@app.get("/api/meetings")
def meetings():
    with db_session() as db:
        return [{**dict(m),"attendance":[dict(a) for a in db.execute("SELECT a.member_id,m.name,a.attended FROM attendance a JOIN members m ON m.id=a.member_id WHERE meeting_id=? ORDER BY m.name COLLATE NOCASE",(m["id"],))]} for m in db.execute("SELECT * FROM meetings ORDER BY meeting_date DESC")]

@app.get("/api/ledger")
def ledger():
    with db_session() as db:
        return [dict(x) for x in db.execute("SELECT 'obligation' kind,o.id,o.member_id,m.name,o.category,o.amount,o.obligation_date record_date,o.created_by actor,o.note FROM obligations o JOIN members m ON m.id=o.member_id UNION ALL SELECT 'payment' kind,t.id,t.member_id,m.name,t.category,t.amount,t.transaction_date record_date,t.recorded_by actor,t.note FROM transactions t JOIN members m ON m.id=t.member_id ORDER BY record_date DESC,id DESC")]

@app.get("/api/report")
def report(as_of: date):
    cutoff=as_of.isoformat()
    with db_session() as db:
        results=[]
        for member in db.execute("SELECT * FROM members ORDER BY name COLLATE NOCASE"):
            mid=member["id"]
            categories={r["category"] for r in db.execute("SELECT category FROM opening_balances WHERE member_id=? AND statement_date<=? UNION SELECT category FROM obligations WHERE member_id=? AND obligation_date<=? UNION SELECT category FROM transactions WHERE member_id=? AND transaction_date<=?",(mid,cutoff,mid,cutoff,mid,cutoff))}
            balances={}
            for category in categories:
                values=db.execute("SELECT COALESCE(SUM(CASE WHEN balance_type='paid_historical' THEN amount ELSE 0 END),0) historical_paid,COALESCE(SUM(CASE WHEN balance_type='opening_arrears' THEN amount ELSE 0 END),0) opening_arrears FROM opening_balances WHERE member_id=? AND category=? AND statement_date<=?",(mid,category,cutoff)).fetchone()
                obligations=db.execute("SELECT COALESCE(SUM(amount),0) n FROM obligations WHERE member_id=? AND category=? AND obligation_date<=?",(mid,category,cutoff)).fetchone()["n"]
                payments=db.execute("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE member_id=? AND category=? AND transaction_date<=?",(mid,category,cutoff)).fetchone()["n"]
                balances[category]={"historical_paid":values["historical_paid"],"opening_arrears":values["opening_arrears"],"obligations":obligations,"payments":payments,"due":round(values["opening_arrears"]+obligations-payments,2)}
            results.append({"member_id":mid,"member_name":member["name"],"status_as_of":status_on(db,mid,cutoff),"categories":balances})
        return {"as_of":cutoff,"members":results,"opening_balances_are_separate":True,"transaction_level_history_complete":False}

@app.get("/api/audit")
def audit_events():
    with db_session() as db: return [dict(x) for x in db.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100")]

@app.post("/api/imports/preview")
def import_preview(item: ImportIn):
    if item.reviewed_by == item.approved_by: raise HTTPException(400,"Reviewer and approver must be different officials.")
    if not item.rows: raise HTTPException(400,"Import must contain member rows.")
    normalized=[]; seen=set()
    fields=("paid_monthly","paid_penalty","paid_savings_500","paid_food","unpaid_monthly","unpaid_penalty","other_balance","total_historical","total_paid","total_unpaid")
    with db_session() as db:
        existing={r["name"].casefold() for r in db.execute("SELECT name FROM members")}
    for raw in item.rows:
        name=str(raw.get("member_name") or raw.get("name") or "").strip()
        if not name: continue
        if name.casefold() in seen: raise HTTPException(400,f"Duplicate member row in import: {name}.")
        seen.add(name.casefold()); status=str(raw.get("existing_status") or raw.get("status") or "STATUS TO CONFIRM").strip().upper()
        if status not in STATUSES: status="STATUS TO CONFIRM"
        row={"member_name":name,"existing_status":status}; issues=[]
        if status=="STATUS TO CONFIRM": issues.append("Missing or unclear membership status")
        for key in fields:
            value=raw.get(key)
            try: row[key]=round(float(value),2) if value is not None and str(value).strip() else None
            except (TypeError,ValueError): row[key]=None
            if row[key] is not None and row[key]<0: row[key]=None
            if row[key] is None and key!="other_balance": issues.append(f"Missing amount: {key}")
        if row["paid_savings_500"] is not None: issues.append('Confirm accounting treatment of original Savings "500" label')
        if row["other_balance"] is None: issues.append("Other balance not specified; confirm if none")
        if name.casefold() in existing: issues.append("Member already exists; verify identity before posting")
        if all(row[k] is not None for k in ("paid_monthly","paid_penalty","paid_savings_500","paid_food","total_paid")) and abs(sum(row[k] for k in ("paid_monthly","paid_penalty","paid_savings_500","paid_food"))-row["total_paid"])>.01: issues.append("Total paid does not match category paid amounts")
        if all(row[k] is not None for k in ("unpaid_monthly","unpaid_penalty","total_unpaid")) and abs(row["unpaid_monthly"]+row["unpaid_penalty"]+(row["other_balance"] or 0)-row["total_unpaid"])>.01: issues.append("Total unpaid does not match category balances")
        if all(row[k] is not None for k in ("total_paid","total_unpaid","total_historical")) and abs(row["total_paid"]+row["total_unpaid"]-row["total_historical"])>.01: issues.append("Historical total does not equal paid plus unpaid")
        row["issues"]=issues; normalized.append(row)
    if not normalized: raise HTTPException(400,"No named member rows found.")
    fingerprint_rows=[{key:value for key,value in row.items() if key!="issues"} for row in normalized]
    fingerprint=hashlib.sha256(json.dumps({"date":item.statement_date.isoformat(),"rows":fingerprint_rows},sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    reconciliation=[]
    compare={"paid_monthly":"paid_monthly","paid_penalty":"paid_penalty","paid_savings_500":"paid_savings_500","paid_food":"paid_food","total_paid":"total_paid","unpaid_monthly":"unpaid_monthly","unpaid_penalty":"unpaid_penalty","total_unpaid":"total_unpaid"}
    for field,reference_key in compare.items():
        imported=round(sum(row[field] or 0 for row in normalized),2)
        reconciliation.append({"category":field,"imported":imported,"reference":REFERENCE[reference_key],"difference":round(imported-REFERENCE[reference_key],2),"status":"MATCH" if abs(imported-REFERENCE[reference_key])<=.01 else "REVIEW"})
    with db_session() as db:
        duplicate=db.execute("SELECT id FROM imports WHERE fingerprint=?",(fingerprint,)).fetchone()
    return {"fingerprint":fingerprint,"duplicate":duplicate is not None,"reference":REFERENCE,"reconciliation":reconciliation,"rows":normalized,"reviewed_by":item.reviewed_by,"approved_by":item.approved_by}

@app.post("/api/imports")
def post_import(item: ImportIn):
    if not item.confirmed: raise HTTPException(400,"Confirm that the import review is complete before posting.")
    preview=import_preview(item)
    if preview["duplicate"]: raise HTTPException(409,"This statement import has already been posted.")
    with db_session() as db:
        try:
            cur=db.execute("INSERT INTO imports(fingerprint,statement_date,source,imported_by,reviewed_by,approved_by,status,reference_json,reconciliation_json,created_at) VALUES(?,?,?,?,?,?,'APPROVED',?,?,?)",(preview["fingerprint"],item.statement_date.isoformat(),item.source,item.imported_by,item.reviewed_by,item.approved_by,json.dumps(REFERENCE),json.dumps(preview["reconciliation"]),timestamp()))
        except sqlite3.IntegrityError: raise HTTPException(409,"This statement import has already been posted.")
        import_id=cur.lastrowid
        for row in preview["rows"]:
            m=db.execute("SELECT id FROM members WHERE name=? COLLATE NOCASE",(row["member_name"],)).fetchone()
            if m: member_id=m["id"]
            else:
                c=db.execute("INSERT INTO members(name,status,created_at) VALUES(?,?,?)",(row["member_name"],row["existing_status"],timestamp())); member_id=c.lastrowid
                db.execute("INSERT INTO status_history(member_id,previous_status,new_status,effective_date,reason,official,created_at) VALUES(?,?,?,?,?,?,?)",(member_id,"NONE",row["existing_status"],item.statement_date.isoformat(),"Imported historical status",item.approved_by,timestamp()))
            amounts={k:row[k] for k in ("paid_monthly","paid_penalty","paid_savings_500","paid_food","unpaid_monthly","unpaid_penalty","other_balance","total_historical","total_paid","total_unpaid")}
            issues=row["issues"]
            c=db.execute("INSERT INTO import_rows(import_id,member_name,existing_status,amounts_json,verification_status,issues_json) VALUES(?,?,?,?,?,?)",(import_id,row["member_name"],row["existing_status"],json.dumps(amounts),"REVIEWED" if issues else "VERIFIED",json.dumps(issues)))
            categories={"paid_monthly":"monthly","paid_penalty":"penalty","paid_savings_500":'Savings "500"',"paid_food":"food","unpaid_monthly":"monthly","unpaid_penalty":"penalty","other_balance":"other"}
            for key,cat in categories.items():
                value=row[key]
                if value is None or value==0: continue
                kind="paid_historical" if key.startswith("paid_") else "opening_arrears"
                db.execute("INSERT INTO opening_balances(import_row_id,member_id,category,amount,balance_type,statement_date,source) VALUES(?,?,?,?,?,?,?)",(c.lastrowid,member_id,cat,value,kind,item.statement_date.isoformat(),item.source))
        audit(db,"historical_import_approved",item.approved_by,"import",import_id,{"source":item.source,"statement_date":item.statement_date.isoformat(),"imported_by":item.imported_by,"reviewed_by":item.reviewed_by,"approved_by":item.approved_by,"rows":len(preview["rows"])})
        return {"id":import_id,"status":"APPROVED","rows":len(preview["rows"]),"reference_is_income":False}

@app.get("/api/imports")
def imports():
    with db_session() as db:
        return [{**dict(x),"reconciliation":json.loads(x["reconciliation_json"]),"rows":[{**dict(r),"amounts":json.loads(r["amounts_json"]),"issues":json.loads(r["issues_json"])} for r in db.execute("SELECT * FROM import_rows WHERE import_id=? ORDER BY member_name",(x["id"],))]} for x in db.execute("SELECT * FROM imports ORDER BY id DESC")]

initialize()
