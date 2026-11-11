import base64
import io
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
import threading
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree as ET

from config import HOST, PORT, SHARE_URL

ROOT = Path(__file__).resolve().parent
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
data_lock = threading.Lock()
sharepoint_sync_lock = threading.Lock()
cached_rows = None
cached_updated_at = None


# Acesso institucional e download da planilha do SharePoint.
def configured():
    return bool(SHARE_URL) and os.name == "nt" and shutil.which("powershell.exe") is not None


def download_workbook():
    if not configured():
        raise RuntimeError("Este conector exige Windows PowerShell e o link da planilha em config.py.")
    script = r"""
$ErrorActionPreference = 'Stop'
try {
    $response = Invoke-WebRequest -Uri $env:SARESP_SHARE_URL -MaximumRedirection 6 -UseBasicParsing -TimeoutSec 60
    if ($response.Headers['Content-Type'] -notlike '*spreadsheetml*') {
        throw "O SharePoint não retornou um arquivo Excel. Verifique se a conta institucional do Windows tem acesso à planilha."
    }
    if ($response.Content.Length -gt 52428800) {
        throw 'A planilha excede o limite de leitura local de 50 MB.'
    }
    [Console]::Out.Write([Convert]::ToBase64String([byte[]]$response.Content))
} catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
"""
    environment = os.environ.copy()
    environment["SARESP_SHARE_URL"] = SHARE_URL + ("&download=1" if "?" in SHARE_URL else "?download=1")
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
            env=environment,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("O SharePoint demorou demais para responder. Tente novamente.") from exc
    except OSError as exc:
        raise RuntimeError(f"Não foi possível iniciar o Windows PowerShell: {exc}") from exc
    if result.returncode:
        message = result.stderr.strip() or "o Windows PowerShell não conseguiu baixar a planilha."
        raise RuntimeError(f"Falha ao acessar o SharePoint com a conta deste Windows: {message}")
    try:
        content = base64.b64decode(result.stdout, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise RuntimeError("O Windows PowerShell recebeu uma resposta inválida do SharePoint.") from exc
    if not content.startswith(b"PK"):
        raise RuntimeError("O SharePoint não retornou um arquivo Excel válido.")
    return content


# Leitura de células, datas e valores do arquivo Excel.
def column_index(reference):
    result = 0
    for char in reference:
        if not char.isalpha():
            break
        result = result * 26 + ord(char.upper()) - ord("A") + 1
    return result - 1


def cell_value(cell, shared_strings):
    cell_type = cell.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{{{MAIN_NS}}}t"))
    value_node = cell.find(f"{{{MAIN_NS}}}v")
    if value_node is None or value_node.text is None or cell_type == "e":
        return None
    value = value_node.text
    if cell_type == "s":
        return shared_strings[int(value)]
    if cell_type == "b":
        return value == "1"
    try:
        number = float(value)
        return int(number) if number.is_integer() else number
    except ValueError:
        return value


def sheet_rows(archive, target, shared_strings):
    target = target.lstrip("/")
    path = posixpath.normpath(target if target.startswith("xl/") else posixpath.join("xl", target))
    root = ET.fromstring(archive.read(path))
    result = {}
    for row in root.iter(f"{{{MAIN_NS}}}row"):
        values = {}
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            index = column_index(cell.get("r", ""))
            if index >= 0:
                values[index] = cell_value(cell, shared_strings)
        result[int(row.get("r", "0"))] = values
    return result


def text_value(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def number_value(value):
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else 0
    normalized = str(value).strip()
    if not normalized or normalized.startswith("#"):
        return 0
    try:
        return float(normalized.replace(".", "").replace(",", ".")) if "," in normalized else float(normalized)
    except ValueError:
        return 0


def is_grade_label(value):
    return bool(
        re.fullmatch(
            r"\d+\s*[ºª](?:\s*(?:ano|série|itinerário))?",
            text_value(value),
            flags=re.IGNORECASE,
        )
    )


def excel_date(value):
    if isinstance(value, (int, float)) and value > 0:
        return (datetime(1899, 12, 30) + timedelta(days=value)).strftime("%d/%m/%Y")
    return text_value(value)


# Conversão das abas Excel para registros de escola e turma.
def parse_workbook(content):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relation_targets = {
            relation.get("Id"): relation.get("Target")
            for relation in relationships.findall(f"{{{PKG_REL_NS}}}Relationship")
        }
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [
                "".join(node.text or "" for node in entry.iter(f"{{{MAIN_NS}}}t"))
                for entry in shared_root.findall(f"{{{MAIN_NS}}}si")
            ]

        rows = []
        workbook_dates = set()
        for sheet in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
            name = sheet.get("name", "")
            normalized_name = name.upper()
            if normalized_name.endswith("(TURMA)"):
                kind = "TURMA"
            elif normalized_name.endswith("(ESCOLA)"):
                kind = "ESCOLA"
            else:
                continue
            relation_id = sheet.get(f"{{{REL_NS}}}id")
            values_by_row = sheet_rows(archive, relation_targets[relation_id], shared_strings)
            header_row = values_by_row.get(3, {})
            school_index = 1 if kind == "TURMA" else 2
            group_starts = (2, 14) if kind == "TURMA" else (3, 14)
            workbook_dates.update(
                day
                for day in (
                    excel_date(header_row.get(group_start))
                    for group_start in group_starts
                )
                if day
            )
            fallback_grade = re.split(r"\s+-\s*", name, maxsplit=1)[0].strip()
            last_school = ""
            empty_school_days = set()

            for row_number in sorted(values_by_row):
                if row_number < 5:
                    continue
                cells = values_by_row[row_number]
                row_school = text_value(cells.get(school_index))
                if " ".join(row_school.split()).casefold() == "resultado total":
                    continue
                school = row_school or last_school
                if school:
                    last_school = school
                if not school:
                    continue

                for group_start in group_starts:
                    offset = group_start
                    grade = text_value(cells.get(offset))
                    if grade.upper().startswith(("PERCENTUAL", "PRIMEIRO DIA", "SEGUNDO DIA")):
                        continue
                    is_sheet_label = "(ESCOLA)" in grade.upper() or "(TURMA)" in grade.upper()
                    if grade and not is_grade_label(grade) and not is_sheet_label:
                        continue
                    turma = text_value(cells.get(offset + 1)) if kind == "TURMA" else ""
                    period = text_value(cells.get(offset + (2 if kind == "TURMA" else 1)))
                    metric_start = offset + (3 if kind == "TURMA" else 2)
                    initial = number_value(cells.get(metric_start))
                    transfers = number_value(cells.get(metric_start + 1))
                    evaded = number_value(cells.get(metric_start + 2))
                    planned = number_value(cells.get(metric_start + 3))
                    present = number_value(cells.get(metric_start + 4))
                    absent = number_value(cells.get(metric_start + 5))
                    day = excel_date(header_row.get(group_start))
                    if kind == "TURMA" and not turma and not any(
                        (initial, transfers, evaded, planned, present, absent)
                    ):
                        continue
                    if not grade and not turma and not any((initial, transfers, evaded, planned, present, absent)):
                        key = (school, day)
                        if key in empty_school_days:
                            continue
                        empty_school_days.add(key)
                    rows.append(
                        {
                            "type": kind,
                            "grade": fallback_grade,
                            "school": school,
                            "turma": turma,
                            "period": period,
                            "day": day,
                            "initial": initial,
                            "transfers": transfers,
                            "evaded": evaded,
                            "planned": planned,
                            "present": present,
                            "absent": absent,
                        }
                    )

        school_names = {}
        for row in rows:
            key = " ".join(row["school"].split()).casefold()
            candidate = " ".join(row["school"].split())
            current = school_names.get(key)
            if current is None or sum(char.islower() for char in candidate) > sum(
                char.islower() for char in current
            ):
                school_names[key] = candidate
        for row in rows:
            row["school"] = school_names[" ".join(row["school"].split()).casefold()]
        return rows, sorted(workbook_dates, key=lambda day: datetime.strptime(day, "%d/%m/%Y"))


# Sincronização do SharePoint e agregação conforme os filtros solicitados.
def sync_sharepoint_data():
    global cached_rows, cached_updated_at
    with sharepoint_sync_lock:
        workbook_data = download_workbook()
        rows, dates = parse_workbook(workbook_data)
        if not rows:
            raise RuntimeError("A planilha abriu, mas não encontrei escolas nas abas de aplicação.")
        updated_at = datetime.now(timezone.utc).isoformat()
        with data_lock:
            cached_rows = rows
            cached_updated_at = updated_at
        return {"rows": rows, "dates": dates, "updatedAt": updated_at}


def aggregate_dashboard(rows, view, filters):
    if view not in ("ESCOLA", "TURMA"):
        raise ValueError("A visão deve ser ESCOLA ou TURMA.")

    school_filter = filters.get("school", "").casefold()
    grade_filter = filters.get("grade", "")
    turma_filter = filters.get("turma", "")
    day_filter = filters.get("day", "")
    search_filter = filters.get("search", "").casefold()
    itinerary_source_grades = {
        "3ª Itinerário": "3º",
        "2ª Itinerário": "2ª",
    }

    def matches(row, include_grade=True):
        if row.get("type") != "TURMA":
            return False
        if school_filter and row.get("school", "").casefold() != school_filter:
            return False
        if (
            include_grade
            and grade_filter
            and row.get("grade", "") != grade_filter
            and row.get("grade", "") != itinerary_source_grades.get(grade_filter)
        ):
            return False
        if turma_filter and row.get("turma", "") != turma_filter:
            return False
        if day_filter and row.get("day", "") != day_filter:
            return False
        searchable = " ".join(
            str(row.get(field, ""))
            for field in ("school", "grade", "turma", "period", "day")
        ).casefold()
        return not search_filter or search_filter in searchable

    selected_rows = [row for row in rows if matches(row)]
    chart_source_rows = [
        row for row in rows if matches(row, include_grade=False)
    ] if day_filter else []

    metrics = ("initial", "transfers", "evaded", "planned", "present", "absent")

    def make_groups(source_rows):
        groups = {}
        for row in source_rows:
            if view == "ESCOLA":
                key = (row.get("school", ""), row.get("day", ""))
            else:
                key = (
                    row.get("school", ""),
                    row.get("grade", ""),
                    row.get("turma", ""),
                    row.get("period", ""),
                    row.get("day", ""),
                )
            group = groups.get(key)
            if group is None:
                group = {
                    "type": view,
                    "school": row.get("school", ""),
                    "grade": row.get("grade", "") if view == "TURMA" else (
                        grade_filter or "Todas as séries"
                    ),
                    "turma": row.get("turma", "") if view == "TURMA" else "",
                    "period": row.get("period", "") if view == "TURMA" else "",
                    "day": row.get("day", ""),
                    **{metric: 0 for metric in metrics},
                }
                groups[key] = group
            for metric in metrics:
                value = row.get(metric, 0)
                if metric == "absent":
                    value = max(value, 0)
                group[metric] += value
        return sorted(
            groups.values(),
            key=lambda row: (
                row["school"].casefold(),
                row["grade"].casefold(),
                row["turma"].casefold(),
                row["period"].casefold(),
                row["day"],
            ),
        )

    grouped_rows = make_groups(selected_rows)
    totals = None
    if day_filter:
        totals = {metric: sum(row[metric] for row in grouped_rows) for metric in metrics}
        totals["participation"] = (
            totals["present"] / totals["planned"] if totals["planned"] else None
        )

    grade_totals = {}
    for row in chart_source_rows:
        grade = row.get("grade", "")
        group = grade_totals.setdefault(grade, {"planned": 0, "present": 0})
        group["planned"] += row.get("planned", 0)
        group["present"] += row.get("present", 0)
    grade_stats = [
        {
            "grade": grade,
            "planned": values["planned"],
            "present": values["present"],
            "participation": (
                values["present"] / values["planned"] if values["planned"] else 0
            ),
        }
        for grade, values in sorted(
            grade_totals.items(), key=lambda item: item[0].casefold()
        )
    ]

    return {
        "view": view,
        "rows": grouped_rows,
        "totals": totals,
        "gradeStats": grade_stats,
        "quality": {
            "negativeAbsences": sum(
                row.get("absent", 0) < 0 for row in selected_rows
            ),
            "presentOverPlanned": sum(
                row.get("planned", 0) > 0
                and row.get("present", 0) > row.get("planned", 0)
                for row in selected_rows
            ),
        },
    }


# Endpoints HTTP do painel e inicialização do servidor local.
class DashboardHandler(BaseHTTPRequestHandler):
    def valid_host(self):
        allowed = {f"{HOST}:{PORT}".lower(), f"localhost:{PORT}".lower()}
        return self.headers.get("Host", "").lower() in allowed

    def valid_post_origin(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in (f"http://{HOST}:{PORT}", f"http://localhost:{PORT}")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.valid_host():
            self.send_error(403)
            return
        path = urlsplit(self.path).path
        if path in ("/", "/index.html", "/index_laranja.html"):
            content = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/styles.css":
            content = (ROOT / "styles.css").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/css; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/assets/ure-itapevi-logo.png":
            content = (ROOT / "assets" / "ure-itapevi-logo.png").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/app.js":
            content = (ROOT / "app.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/config.js":
            content = (ROOT / "config.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/LEIA-ME.md":
            content = (ROOT / "LEIA-ME.md").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/api/status":
            with data_lock:
                connected = cached_rows is not None
                updated_at = cached_updated_at
            self.send_json(
                200,
                {
                    "service": "painel-saresp",
                    "configured": configured(),
                    "connected": connected,
                    "updatedAt": updated_at,
                    "error": "" if configured() else "Windows PowerShell não está disponível nesta máquina.",
                },
            )
            return
        if path == "/api/data":
            try:
                self.send_json(200, sync_sharepoint_data())
            except Exception as exc:
                self.send_json(502, {"error": str(exc)})
            return
        if path == "/api/dashboard":
            with data_lock:
                rows = cached_rows
            if rows is None:
                self.send_json(409, {"error": "Conecte-se à planilha antes de consultar o painel."})
                return
            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
            filters = {
                key: query.get(key, [""])[0]
                for key in ("school", "grade", "turma", "day", "search")
            }
            view = query.get("view", ["ESCOLA"])[0]
            try:
                self.send_json(200, aggregate_dashboard(rows, view, filters))
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            return
        self.send_error(404)

    def do_POST(self):
        if not self.valid_host() or not self.valid_post_origin():
            self.send_error(403)
            return
        if self.path == "/auth/login":
            if not configured():
                self.send_json(503, {"error": "Windows PowerShell é necessário para acessar o link institucional."})
                return
            try:
                self.send_json(200, {"connected": True, **sync_sharepoint_data()})
            except Exception as exc:
                self.send_json(502, {"error": str(exc)})
            return
        if self.path == "/auth/logout":
            try:
                global cached_rows, cached_updated_at
                with sharepoint_sync_lock:
                    with data_lock:
                        cached_rows = None
                        cached_updated_at = None
                self.send_json(200, {"connected": False})
            except Exception as exc:
                self.send_json(500, {"error": f"Não foi possível desconectar o painel: {exc}"})
            return
        self.send_error(404)

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}")


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 10048 or exc.errno in (48, 98, 10048):
            raise SystemExit(
                f"Já existe um programa usando a porta {PORT}. Feche o outro painel/servidor e execute INICIAR_PAINEL.bat novamente."
            ) from exc
        raise
    print(f"Painel disponível em http://{HOST}:{PORT}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()
