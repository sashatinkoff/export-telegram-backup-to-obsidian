#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Выгрузка чата Telegram через API (MTProto, библиотека Telethon) в формат экспорта Telegram Desktop.

Скрипт запускается плагином Obsidian «Telegram Import» и общается с ним строками JSON:
  - всё, что скрипт печатает в stdout, это строки JSON с полем event (log, progress, ask, chat, done, error ...);
  - на запрос event=ask плагин отвечает одной строкой JSON со значением (строка) в stdin.
Команды: check, login, chats, export. Ключи API передаются переменными окружения TGI_API_ID и TGI_API_HASH.
Можно запускать и руками: python tg_export.py export --chat @name --out ./out --session ./sess
"""
import argparse
import asyncio
import time
import datetime
import json
import mimetypes
import os
import re
import sys

VERSION = 1

ENTITY_TYPES = {
    'MessageEntityBold': 'bold',
    'MessageEntityItalic': 'italic',
    'MessageEntityUnderline': 'underline',
    'MessageEntityStrike': 'strikethrough',
    'MessageEntityCode': 'code',
    'MessageEntityPre': 'pre',
    'MessageEntityTextUrl': 'text_link',
    'MessageEntityUrl': 'link',
    'MessageEntityHashtag': 'hashtag',
    'MessageEntityBlockquote': 'blockquote',
    'MessageEntitySpoiler': 'spoiler',
    'MessageEntityCustomEmoji': 'custom_emoji',
}  # остальные (упоминания, почта, команды и т. д.) остаются обычным текстом, чтобы текст не терялся


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(message, level='info'):
    emit(event='log', level=level, message=message)


def ask(key, prompt):
    """Просит плагин ввести значение (телефон, код, пароль) и ждёт ответ строкой JSON."""
    emit(event='ask', key=key, prompt=prompt)
    line = sys.stdin.readline()
    if not line:
        raise SystemExit(2)
    value = json.loads(line)
    if value is None:
        raise SystemExit('Отменено')
    return str(value)


# ---------------------------------------------------------------- преобразование сообщений

def to_local(dt):
    """Дата сообщения (UTC) -> местное время без часового пояса, как в экспорте Telegram Desktop."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone().replace(tzinfo=None)


def iso(dt):
    return to_local(dt).strftime('%Y-%m-%dT%H:%M:%S')


def stamp(dt):
    """Суффикс в именах файлов, как у Telegram Desktop: 05-03-2019_21-14-18."""
    return to_local(dt).strftime('%d-%m-%Y_%H-%M-%S')


def unix(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return str(int(dt.timestamp()))


def build_entities(text, entities):
    """Плоский список text_entities как в экспорте Telegram Desktop. Смещения Telegram считаются в UTF-16."""
    data = (text or '').encode('utf-16-le')
    out = []
    pos = 0
    for e in sorted(entities or [], key=lambda x: (x.offset, -x.length)):
        start = e.offset * 2
        end = min(len(data), start + e.length * 2)
        if start < pos or end <= start:
            continue  # вложенные и пересекающиеся выделения пропускаем: остаётся внешнее
        if start > pos:
            out.append({'type': 'plain', 'text': data[pos:start].decode('utf-16-le', 'replace')})
        item = {'type': ENTITY_TYPES.get(type(e).__name__, 'plain'), 'text': data[start:end].decode('utf-16-le', 'replace')}
        if item['type'] == 'text_link':
            item['href'] = getattr(e, 'url', '')
        if item['type'] == 'pre':
            item['language'] = getattr(e, 'language', '') or ''
        if out and out[-1]['type'] == 'plain' and item['type'] == 'plain':
            out[-1]['text'] += item['text']  # соседние обычные куски склеиваем
        else:
            out.append(item)
        pos = end
    if pos < len(data):
        tail = data[pos:].decode('utf-16-le', 'replace')
        if out and out[-1]['type'] == 'plain':
            out[-1]['text'] += tail
        else:
            out.append({'type': 'plain', 'text': tail})
    return out


def text_field(entities):
    """Поле text: строка, если форматирования нет, иначе список строк и словарей (как в экспорте)."""
    if all(x['type'] == 'plain' for x in entities):
        return ''.join(x['text'] for x in entities)
    return [x['text'] if x['type'] == 'plain' else {k: v for k, v in x.items()} for x in entities]


def media_kind(msg):
    """Вид медиа: photo, video_file, voice_message, video_message, sticker, animation, audio_file, file или None."""
    if getattr(msg, 'photo', None):
        return 'photo'
    if getattr(msg, 'document', None) is None:
        return None
    if getattr(msg, 'sticker', None):
        return 'sticker'
    if getattr(msg, 'voice', None):
        return 'voice_message'
    if getattr(msg, 'video_note', None):
        return 'video_message'
    if getattr(msg, 'gif', None):
        return 'animation'
    if getattr(msg, 'video', None):
        return 'video_file'
    if getattr(msg, 'audio', None):
        return 'audio_file'
    return 'file'


FOLDERS = {
    'photo': 'photos', 'video_file': 'video_files', 'voice_message': 'voice_messages', 'video_message': 'round_video_messages',
    'sticker': 'stickers', 'animation': 'video_files', 'audio_file': 'files', 'file': 'files',
}
PREFIX = {
    'photo': 'photo', 'video_file': 'video', 'voice_message': 'audio', 'video_message': 'round', 'sticker': 'sticker',
    'animation': 'animation', 'audio_file': 'audio', 'file': 'file',
}
KEEP_ORIGINAL = ('file', 'audio_file')  # документы и музыка сохраняют исходное имя, остальное получает дату в имени


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', name).strip(' .')
    return name[:120] or 'file'


def file_ext(msg, kind):
    f = getattr(msg, 'file', None)
    ext = getattr(f, 'ext', None) if f is not None else None
    if not ext and getattr(f, 'mime_type', None):
        ext = mimetypes.guess_extension(f.mime_type)
    if not ext:
        ext = '.jpg' if kind == 'photo' else ''
    return {'.oga': '.ogg', '.jpe': '.jpg', '.jpeg': '.jpg'}.get(ext.lower(), ext)


def plan_media_name(msg, kind, taken):
    """Относительный путь файла в папке выгрузки. taken — словарь «путь -> id сообщения»: имена не должны совпадать."""
    f = getattr(msg, 'file', None)
    original = getattr(f, 'name', None) if f is not None else None
    ext = file_ext(msg, kind)
    folder = FOLDERS[kind]
    if kind in KEEP_ORIGINAL and original:
        stem, oext = os.path.splitext(safe_name(original))
        ext = oext or ext
        rel = f'{folder}/{stem}{ext}'
        if taken.get(rel, msg.id) != msg.id:
            rel = f'{folder}/{stem}_{msg.id}{ext}'
        return rel
    stem = os.path.splitext(safe_name(original))[0] if original else f'{PREFIX[kind]}_{msg.id}'
    rel = f'{folder}/{stem}@{stamp(msg.date)}{ext}'
    if taken.get(rel, msg.id) != msg.id:
        rel = f'{folder}/{stem}_{msg.id}@{stamp(msg.date)}{ext}'
    return rel


def person_name(x):
    if x is None:
        return None
    title = getattr(x, 'title', None)
    if title:
        return title
    name = ' '.join(p for p in (getattr(x, 'first_name', None), getattr(x, 'last_name', None)) if p)
    return name or getattr(x, 'username', None)


def forwarded_from(msg):
    fwd = getattr(msg, 'fwd_from', None)
    if fwd is None:
        return None
    if getattr(fwd, 'from_name', None):
        return fwd.from_name
    forward = getattr(msg, 'forward', None)
    for attr in ('chat', 'sender'):
        try:
            name = person_name(getattr(forward, attr, None))
        except Exception:
            name = None
        if name:
            return name
    return None


def convert_message(msg, chat_title='', media_rel=None):
    """Сообщение Telethon -> словарь в формате result.json Telegram Desktop. None — сообщение пропускаем."""
    if type(msg).__name__ in ('MessageService', 'MessageEmpty'):
        return None
    entities = build_entities(getattr(msg, 'raw_text', None) or getattr(msg, 'message', '') or '', getattr(msg, 'entities', None))
    kind = media_kind(msg)
    if not entities and not (media_rel and kind):
        return None
    out = {
        'id': msg.id,
        'type': 'message',
        'date': iso(msg.date),
        'date_unixtime': unix(msg.date),
    }
    edit = getattr(msg, 'edit_date', None)
    if edit:
        out['edited'] = iso(edit)
        out['edited_unixtime'] = unix(edit)
    out['from'] = person_name(getattr(msg, 'sender', None)) or chat_title
    fwd = forwarded_from(msg)
    if fwd:
        out['forwarded_from'] = fwd
    reply = getattr(msg, 'reply_to_msg_id', None)
    if reply:
        out['reply_to_message_id'] = reply
    if media_rel and kind:
        if kind == 'photo':
            out['photo'] = media_rel
        else:
            out['file'] = media_rel
            out['media_type'] = kind
    out['text'] = text_field(entities)
    out['text_entities'] = entities
    return out


def chat_kind(entity):
    n = type(entity).__name__
    if n == 'User':
        return 'personal_chat'
    if n == 'Chat':
        return 'private_group'
    if n == 'Channel':
        public = bool(getattr(entity, 'username', None))
        if getattr(entity, 'broadcast', False):
            return 'public_channel' if public else 'private_channel'
        return 'public_supergroup' if public else 'private_supergroup'
    return 'private_group'


# ---------------------------------------------------------------- работа с Telegram

def parse_proxy(url):
    """socks5://user:pass@host:port, socks4://host:port или http://host:port -> кортеж прокси для Telethon (None, если пусто)."""
    url = (url or '').strip()
    if not url:
        return None
    from urllib.parse import urlsplit, parse_qs
    u = urlsplit(url if '://' in url else 'socks5://' + url)
    # ссылки из Telegram: https://t.me/proxy?server=…&port=…&secret=…, tg://proxy?…, https://t.me/socks?server=…&port=…
    link = u.path.strip('/') if u.hostname in ('t.me', 'telegram.me') else (u.hostname if u.scheme == 'tg' else '')
    if link in ('proxy', 'socks'):
        q = parse_qs(u.query)
        server, port = (q.get('server') or [''])[0], (q.get('port') or [''])[0]
        if not server or not port.isdigit():
            raise SystemExit(f'В ссылке на прокси нет server или port: «{url}»')
        if link == 'proxy':
            return parse_proxy(f"mtproxy://{server}:{port}?secret={(q.get('secret') or [''])[0]}")
        user, pw = (q.get('user') or [None])[0], (q.get('pass') or [None])[0]
        return ('socks5', server, int(port), True, user, pw)
    if u.scheme in ('mtproxy', 'mtproto', 'tg'):
        secret = (parse_qs(u.query).get('secret') or [''])[0]
        if not u.hostname or not u.port or not secret:
            raise SystemExit(f'Для MTProxy нужны адрес, порт и secret: mtproxy://127.0.0.1:1443?secret=…  (получено «{url}»)')
        sec = secret.lower()
        if sec.startswith('ee') and len(sec) > 34:
            raise SystemExit('Секрет начинается с ee: это Fake TLS, Telethon его не поддерживает. '
                             'Возьмите обычный секрет (32 символа, можно с префиксом dd) из настроек прокси.')
        if len(sec) not in (32, 34):
            raise SystemExit(f'Секрет MTProxy должен быть 32 hex-символа (или 34 с префиксом dd), в ссылке {len(sec)}: проверьте, что секрет скопирован целиком.')
        return ('mtproxy', u.hostname, u.port, secret)
    kind = {'socks5': 'socks5', 'socks5h': 'socks5', 'socks4': 'socks4', 'http': 'http', 'https': 'http'}.get(u.scheme)
    if not kind or not u.hostname or not u.port:
        raise SystemExit(f'Не понял адрес прокси «{url}». Пример: socks5://127.0.0.1:1080')
    return (kind, u.hostname, u.port, True, u.username, u.password)


def ensure_pkg(module, spec, why):
    """Если нужной библиотеки нет (старая установка), доустанавливаем её сами."""
    try:
        __import__(module)
        return
    except ImportError:
        pass
    log(f'Для {why} нужен {spec}, устанавливаю…')
    import subprocess, sys
    r = subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-cache-dir', spec],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
    if r.returncode != 0:
        raise SystemExit(f'Не удалось установить {spec}: ' + (r.stdout or '')[-300:])
    import importlib
    importlib.invalidate_caches()


def make_client(session, api_id, api_hash):
    from telethon import TelegramClient  # импорт здесь, чтобы check работал без установленного Telethon
    kwargs = {'flood_sleep_threshold': 600, 'timeout': 15, 'connection_retries': 2, 'retry_delay': 1}
    proxy = parse_proxy(os.environ.get('TGI_PROXY', ''))
    if proxy and proxy[0] == 'mtproxy':
        from telethon.network import ConnectionTcpMTProxyRandomizedIntermediate
        kwargs['connection'] = ConnectionTcpMTProxyRandomizedIntermediate
        kwargs['proxy'] = proxy[1:]
    elif proxy:
        ensure_pkg('python_socks', 'python-socks[asyncio]', 'прокси')
        kwargs['proxy'] = proxy
    return TelegramClient(session, int(api_id), api_hash, **kwargs)


NETWORK_HINT = ('Не удалось подключиться к Telegram: соединение обрывается. Обычно это блокировка или нужен VPN. '
                'Включите VPN для всей системы (режим «весь трафик») или укажите прокси в настройках синхронизации.')


def friendly_error(e):
    """Понятное сообщение для типичных сетевых ошибок."""
    if isinstance(e, (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, TimeoutError, OSError)) \
            and type(e).__name__ not in ('FileNotFoundError', 'PermissionError', 'IsADirectoryError', 'NotADirectoryError'):
        return f'{NETWORK_HINT} ({type(e).__name__}: {e})'
    return f'{type(e).__name__}: {e}'


async def connect(client, seconds=20):
    """Подключение с ограничением времени и перебором способов: обычный TCP, затем обфусцированный
    (его не режут DPI-фильтры, как у Telegram Desktop), затем сокращённый. Без таймаута при блокировке скрипт молча ждал бы."""
    from telethon.network import (ConnectionTcpFull, ConnectionTcpObfuscated, ConnectionTcpAbridged)
    variants = [('обычное', ConnectionTcpFull), ('обфусцированное', ConnectionTcpObfuscated), ('сокращённое', ConnectionTcpAbridged)]
    from telethon.network.connection.tcpmtproxy import TcpMTProxy
    cur = getattr(client, '_connection', None)
    if isinstance(cur, type) and issubclass(cur, TcpMTProxy):
        variants = [('через MTProxy', cur)]
    elif os.environ.get('TGI_PROXY', '').strip():
        # прокси вроде tg-ws-proxy определяют дата-центр по обфусцированному заголовку, как у Telegram Desktop: он идёт первым
        variants = [variants[1], variants[0], variants[2]]
    last = None
    for i, (title, cls) in enumerate(variants):
        log(f'Подключение к Telegram ({title}), попытка {i + 1} из {len(variants)}…')
        if len(variants) > 1 and hasattr(client, '_connection'):
            client._connection = cls
        try:
            await asyncio.wait_for(client.connect(), seconds)
            if not hasattr(client, 'is_connected') or client.is_connected():
                log('Соединение установлено')
                return
        except Exception as e:  # noqa: BLE001
            last = e
            log(f'Не вышло: {type(e).__name__}')
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass
    raise last or ConnectionError('нет соединения')


def credentials():
    api_id = os.environ.get('TGI_API_ID', '').strip()
    api_hash = os.environ.get('TGI_API_HASH', '').strip()
    if not api_id or not api_hash:
        raise SystemExit('Не заданы api_id и api_hash (настройки плагина, блок «Синхронизация через API»)')
    return api_id, api_hash


def secure(path):
    try:
        for p in (path, path + '.session'):
            if os.path.exists(p):
                os.chmod(p, 0o600)
    except OSError:
        pass


def qr_matrix(url):
    """Матрица QR-кода строками из 0 и 1 (рисует плагин)."""
    ensure_pkg('qrcode', 'qrcode', 'QR-кода')
    import qrcode
    qr = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_L)
    qr.add_data(url)
    qr.make(fit=True)
    return [''.join('1' if c else '0' for c in row) for row in qr.get_matrix()]


async def login_qr(client):
    """Вход по QR-коду: Telegram → Настройки → Устройства → Подключить устройство. Код в сообщении не нужен."""
    from telethon.errors import SessionPasswordNeededError
    qr = await client.qr_login()
    deadline = time.time() + 300

    async def with_password():
        password = ask('password', 'Пароль двухэтапной проверки (облачный пароль Telegram)')
        await client.sign_in(password=password)

    while time.time() < deadline:
        emit(event='qr', url=qr.url, matrix=qr_matrix(qr.url))
        try:
            await qr.wait(25)
            return
        except asyncio.TimeoutError:
            pass
        except SessionPasswordNeededError:
            await with_password()
            return
        # время ожидания вышло: просим новый токен; если QR как раз отсканировали, вместо токена придёт «успех»
        try:
            await qr.recreate()
        except SessionPasswordNeededError:
            await with_password()
            return
        resp = getattr(qr, '_resp', None)
        if type(resp).__name__ == 'LoginTokenSuccess':
            client._on_login(resp.authorization.user)
            return
    raise SystemExit('QR-код не был отсканирован за 5 минут')


async def cmd_login(args):
    api_id, api_hash = credentials()
    client = make_client(args.session, api_id, api_hash)
    await connect(client)
    try:
        if await client.is_user_authorized():
            me = await client.get_me()
            emit(event='logged_in', name=person_name(me) or '', phone=getattr(me, 'phone', '') or '')
            return 0
        if getattr(args, 'qr', False):
            await login_qr(client)
            me = await client.get_me()
            emit(event='logged_in', name=person_name(me) or '', phone=getattr(me, 'phone', '') or '')
            return 0
        phone = ask('phone', 'Номер телефона в международном формате, например +79001234567')
        from telethon.errors import PhoneNumberInvalidError, FloodWaitError
        try:
            sent = await client.send_code_request(phone)
        except PhoneNumberInvalidError:
            raise SystemExit('Неверный номер телефона. Нужен международный формат, например +79001234567')
        except FloodWaitError as e:
            raise SystemExit(f'Telegram просит подождать {e.seconds} с перед новым кодом (слишком много попыток)')
        code = None
        resent = False
        for attempt in range(3):
            kind = type(getattr(sent, 'type', None)).__name__
            where = {'SentCodeTypeApp': 'сообщением в приложение Telegram на другом вашем устройстве (чат «Telegram», не SMS)',
                     'SentCodeTypeSms': 'по SMS', 'SentCodeTypeCall': 'звонком', 'SentCodeTypeFlashCall': 'звонком (последние цифры номера)',
                     'SentCodeTypeMissedCall': 'звонком (последние цифры номера)'}.get(kind, f'способом {kind}')
            log(f'Код отправлен {where}')
            nxt = getattr(sent, 'next_type', None)
            hint = 'Код из Telegram'
            if nxt is not None and attempt < 2:
                hint += '. Не пришёл? Оставьте поле пустым и нажмите «ОК»: код будет отправлен другим способом (SMS или звонок)'
            code = ask('code', hint).strip()
            if code:
                break
            if nxt is None:
                raise SystemExit('Код не введён')
            from telethon.tl import functions
            sent = await client(functions.auth.ResendCodeRequest(phone, sent.phone_code_hash))
            resent = True
        if not code:
            raise SystemExit('Код не введён')
        from telethon.errors import SessionPasswordNeededError
        try:
            if resent:
                await client.sign_in(phone, code.strip(), phone_code_hash=sent.phone_code_hash)
            else:
                await client.sign_in(phone, code.strip())
        except SessionPasswordNeededError:
            password = ask('password', 'Пароль двухэтапной проверки (облачный пароль Telegram)')
            await client.sign_in(password=password)
        me = await client.get_me()
        emit(event='logged_in', name=person_name(me) or '', phone=getattr(me, 'phone', '') or '')
        return 0
    finally:
        await client.disconnect()
        secure(args.session)


async def require_login(client):
    await connect(client)
    if not await client.is_user_authorized():
        emit(event='error', code='not_authorized', message='Нет входа в Telegram. Нажмите «Войти в Telegram» в настройках плагина')
        return False
    return True


async def cmd_chats(args):
    api_id, api_hash = credentials()
    client = make_client(args.session, api_id, api_hash)
    try:
        if not await require_login(client):
            return 3
        n = 0
        async for d in client.iter_dialogs():
            emit(event='chat', id=d.id, title=d.name or '', kind=chat_kind(d.entity), username=getattr(d.entity, 'username', None))
            n += 1
        emit(event='done', chats=n)
        return 0
    finally:
        await client.disconnect()


def parse_local(s):
    if not s:
        return None
    return datetime.datetime.fromisoformat(s).astimezone()  # без часового пояса = местное время


def load_state(out):
    try:
        with open(os.path.join(out, '.tgi_state.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(out, state):
    tmp = os.path.join(out, '.tgi_state.json.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(out, '.tgi_state.json'))


async def download(client, msg, path):
    """Скачивает файл. При ограничении частоты (FloodWait) ждёт и повторяет."""
    from telethon.errors import FloodWaitError
    for attempt in range(3):
        try:
            return await client.download_media(msg, file=path)
        except FloodWaitError as e:
            emit(event='wait', seconds=e.seconds, message=f'Telegram просит подождать {e.seconds} с')
            await asyncio.sleep(e.seconds + 1)
    return None


async def cmd_export(args):
    api_id, api_hash = credentials()
    since = parse_local(args.since)
    until = parse_local(args.until)
    os.makedirs(args.out, exist_ok=True)
    state = load_state(args.out)
    taken = state.get('taken', {})  # относительный путь -> id сообщения
    client = make_client(args.session, api_id, api_hash)
    try:
        if not await require_login(client):
            return 3
        chat = args.chat
        if re.fullmatch(r'-?\d+', chat):
            chat = int(chat)
        entity = await client.get_entity(chat)
        title = person_name(entity) or str(chat)
        log(f'Чат: {title}')
        total = None
        if since is None and until is None:
            try:
                total = (await client.get_messages(entity, limit=0)).total
            except Exception:
                total = None
        kwargs = {'reverse': True}
        if since is not None:
            kwargs['offset_date'] = (since - datetime.timedelta(seconds=1)).astimezone(datetime.timezone.utc)
        messages = []
        done = media_n = skipped = 0
        max_bytes = int(args.max_media_mb * 1024 * 1024) if args.max_media_mb else 0
        async for msg in client.iter_messages(entity, **kwargs):
            local = to_local(msg.date).astimezone()
            if since is not None and local < since:
                continue
            if until is not None and local > until:
                break
            done += 1
            rel = None
            kind = media_kind(msg) if args.media else None
            if kind:
                size = getattr(getattr(msg, 'file', None), 'size', 0) or 0
                if max_bytes and size > max_bytes:
                    skipped += 1
                    log(f'Пропущен файл {size // 1048576} МБ (сообщение {msg.id}): больше лимита {args.max_media_mb} МБ', 'warn')
                else:
                    rel = state.get('messages', {}).get(str(msg.id)) or plan_media_name(msg, kind, taken)
                    abs_path = os.path.join(args.out, *rel.split('/'))
                    if not os.path.exists(abs_path):
                        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                        try:
                            got = await download(client, msg, abs_path)
                        except Exception as e:  # noqa: BLE001 — один плохой файл не должен ронять выгрузку
                            got = None
                            log(f'Не удалось скачать файл сообщения {msg.id}: {e}', 'warn')
                        if not got:
                            rel = None
                            skipped += 1
                        else:
                            media_n += 1
                    if rel:
                        taken[rel] = msg.id
                        state.setdefault('messages', {})[str(msg.id)] = rel
            item = convert_message(msg, title, rel)
            if item:
                messages.append(item)
            if done % 25 == 0:
                emit(event='progress', done=done, total=total, label=to_local(msg.date).strftime('%Y-%m-%d'))
        emit(event='progress', done=done, total=total or done, label='')
        state['taken'] = taken
        save_state(args.out, state)
        data = {'name': title, 'type': chat_kind(entity), 'id': getattr(entity, 'id', 0), 'messages': messages}
        tmp = os.path.join(args.out, 'result.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, os.path.join(args.out, 'result.json'))
        emit(event='done', messages=len(messages), scanned=done, media=media_n, skipped=skipped, out=args.out,
             first=messages[0]['date'] if messages else None, last=messages[-1]['date'] if messages else None)
        return 0
    finally:
        await client.disconnect()


def cmd_check(_args):
    info = {'event': 'check', 'script': VERSION, 'python': sys.version.split()[0], 'telethon': None}
    try:
        import telethon
        info['telethon'] = telethon.__version__
    except Exception as e:  # noqa: BLE001
        info['error'] = str(e)
    emit(**info)
    return 0 if info['telethon'] else 4


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('check')
    for name in ('login', 'chats', 'export'):
        s = sub.add_parser(name)
        s.add_argument('--session', required=True, help='путь к файлу сессии (без .session)')
    sub.choices['login'].add_argument('--qr', action='store_true', help='войти по QR-коду вместо кода из сообщения')
    e = sub.choices['export']
    e.add_argument('--chat', required=True, help='@имя, ссылка, номер телефона или числовой id')
    e.add_argument('--out', required=True, help='папка выгрузки (result.json и медиа)')
    e.add_argument('--since', default='', help='с какой даты и времени (местные, ГГГГ-ММ-ДДTЧЧ:ММ:СС), включительно')
    e.add_argument('--until', default='', help='по какую дату и время, включительно')
    e.add_argument('--media', dest='media', action='store_true', default=True)
    e.add_argument('--no-media', dest='media', action='store_false')
    e.add_argument('--max-media-mb', type=float, default=0, help='не скачивать файлы больше N МБ (0 — без ограничения)')
    args = p.parse_args(argv)
    try:
        if args.cmd == 'check':
            return cmd_check(args)
        runner = {'login': cmd_login, 'chats': cmd_chats, 'export': cmd_export}[args.cmd]
        return asyncio.run(runner(args))
    except SystemExit as e:
        if isinstance(e.code, str):
            emit(event='error', message=e.code)
            return 1
        raise
    except Exception as e:  # noqa: BLE001
        emit(event='error', message=friendly_error(e))
        return 1


if __name__ == '__main__':
    sys.exit(main())
