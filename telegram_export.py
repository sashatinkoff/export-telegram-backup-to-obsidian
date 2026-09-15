#!/usr/bin/env python3
import os
import re
import json
import shutil
import argparse
from datetime import datetime
from dateutil import parser
from pathlib import Path

# Чтобы "зашить" ключ прямо в скрипт — впиши его сюда между кавычками.
# Взять ключ: https://developer.tech.yandex.ru/ -> "Подключить API" -> Static API
YANDEX_MAPS_API_KEY = ""

class TelegramExport:
    _MONTHS_RU_GENITIVE = {
        1: "января", 2: "февраля", 3: "марта", 4: "апреля",
        5: "мая", 6: "июня", 7: "июля", 8: "августа",
        9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
    }

    def __init__(self, yandex_maps_api_key=None, header_date_format=None):
        self.date_format = "%Y-%m-%dT%H:%M:%S"
        self.file_date_format = "%Y-%m-%d %H-%M-%S"
        self.yandex_maps_api_key = yandex_maps_api_key
        # None -> дата по умолчанию: "7 сентября 2026, 09:41".
        # Иначе — strftime-совместимая строка формата, например "%d.%m.%Y %H:%M".
        self.header_date_format = header_date_format

    def format_header_date(self, date_obj):
        if self.header_date_format:
            return date_obj.strftime(self.header_date_format)
        month = self._MONTHS_RU_GENITIVE[date_obj.month]
        return f"{date_obj.day} {month} {date_obj.year}, {date_obj.strftime('%H:%M')}"

    def save_posts(self, posts, output_folder):
        for index, post in enumerate(posts):
            prev_file = posts[index - 1].get('file_name') if index > 0 else None
            next_file = posts[index + 1].get('file_name') if index < len(posts) - 1 else None
            header = self.create_header(post, next_file, prev_file)

            content = post['text'].strip()

            if content:
                text = f"{header}\n\n{content}"
            else:
                text = header  # только заголовок + медиа ниже (если есть)

            file_path = self.save_to_file(text, post['date'], post['file_name'], output_folder)
            print(f"Saved {index + 1}/{len(posts)}, file={file_path}")

    def copy_folders(self, input_folder, output_folder):
        if not os.path.exists(output_folder):
            os.makedirs(output_folder)

        skip_exts = {'.jpg', '.jpeg', '.png', '.webp'}

        def is_thumbnail(file_name: str) -> bool:
            name = file_name.lower()

            return (
                "_thumb" in name or
                "_preview" in name or
                name.endswith(".mp4.jpg") or
                name.endswith(".mp4_thumb.jpg")
            )

        for root, dirs, files in os.walk(input_folder):
            rel_path = os.path.relpath(root, input_folder)
            dest_root = os.path.join(output_folder, rel_path)
            os.makedirs(dest_root, exist_ok=True)

            for file in files:
                # 🚫 result.json — исходные данные экспорта, в output не нужен
                if rel_path == '.' and file == 'result.json':
                    continue

                ext = os.path.splitext(file)[1].lower()

                # 🚫 убираем thumbnails ВСЕГДА (не только video folder)
                if ext in skip_exts and is_thumbnail(file):
                    continue

                src_path = os.path.join(root, file)
                dest_path = os.path.join(dest_root, file)

                try:
                    shutil.copy2(src_path, dest_path)
                except Exception as e:
                    print(f"Error copying {src_path}: {e}")
                    

    def is_thumbnail(file_name: str) -> bool:
        name = file_name.lower()

        # Telegram video thumbnails
        if "_thumb" in name:
            return True

        if name.endswith(".mp4.jpg"):
            return True

        if name.endswith(".mp4_thumb.jpg"):
            return True

        if "_preview" in name:
            return True

        return False

    # Три и более переносов строки подряд -> двойной перенос (один пустой абзац)
    _MULTI_NEWLINE_RE = re.compile(r'\n{3,}')

    def collapse_newlines(self, text):
        """Схлопывает 3 и более идущих подряд переносов строки в двойной перенос"""
        if not text:
            return text
        return self._MULTI_NEWLINE_RE.sub('\n\n', text)

    def save_to_file(self, text, date, file_name, output_folder):
        text = self.collapse_newlines(text)

        date_obj = parser.parse(date)
        folder_name = self.get_folder_name(date_obj.year, date_obj.month)
        folder_path = os.path.join(output_folder, folder_name)

        if not os.path.exists(folder_path):
            os.makedirs(folder_path)

        file_path = os.path.join(folder_path, file_name)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(text)

        return file_path

    def get_folder_name(self, year, month):
        month_name = datetime(year, month, 1).strftime('%B')
        formatted_month = f"{month:02d}"
        return f"notes/{year}/{year}-{formatted_month}-{month_name.capitalize()}"

    def get_posts(self, json_data, threshold=120):
        """threshold — максимальный разрыв между сообщениями (в секундах) для склейки в один пост.
        threshold=0 отключает склейку: каждое сообщение становится отдельным постом."""
        messages = json_data.get('messages', [])
        posts = []

        start = 0

        while start < len(messages):
            group_messages = []

            # старт группы
            group_messages.append(messages[start])
            prev_time = parser.parse(messages[start]['date'])

            idx = start + 1

            # собираем цепочку сообщений по времени
            while idx < len(messages):
                current_msg = messages[idx]
                msg_time = parser.parse(current_msg['date'])

                # разрыв больше 2 минут → новая группа
                if (msg_time - prev_time).total_seconds() >= threshold:
                    break

                group_messages.append(current_msg)
                prev_time = msg_time
                idx += 1

            # формируем пост
            post = self.process_group(group_messages)
            posts.append(post)

            # следующий старт
            start = idx

        return posts


    def process_group(self, group_messages):
        """
        Принимает список сообщений одной временной группы.
        Возвращает словарь поста (id, date, text, file_name, hash_tags, geo, author, forwarded_from)
        """

        text_messages = []
        media_messages = []

        for msg in group_messages:
            if self._has_text(msg):
                text_messages.append(msg)
            else:
                media_messages.append(msg)

        primary_msg = text_messages[0] if text_messages else group_messages[0]

        text_parts = []

        # 1. текстовые сообщения
        for msg in text_messages:
            part = self.create_text(msg)
            if part:
                text_parts.append(part)

        # 2. медиа-сообщения
        media_parts = []
        for msg in media_messages:
            part = self.create_text(msg)
            if part:
                media_parts.append(part)

        # итоговый текст
        full_text = "\n".join(text_parts + media_parts).strip()

        # --- ВАЖНО: fallback для "чисто медиа" ---
        if not full_text and media_messages:
            fallback_media = []

            for msg in media_messages:
                media_md = self.create_media_markdown(msg)
                if media_md:
                    fallback_media.append(media_md)

            full_text = "\n".join(fallback_media).strip()

        # --- hashtags ---
        all_tags = []
        for msg in group_messages:
            for entity in msg.get('text_entities', []):
                if entity.get('type') == 'hashtag':
                    tag = entity.get('text', '').replace('#', '')
                    if tag and tag not in all_tags:
                        all_tags.append(tag)

            if msg.get('rich_message'):
                for block in msg['rich_message'].get('blocks', []):
                    self._collect_hashtags_from_block(block, all_tags)

        # Хэштеги в конце текста дублируют tags во frontmatter — убираем их из тела
        full_text = self.strip_trailing_hashtags(full_text)

        return {
            'id': primary_msg.get('id'),
            'date': primary_msg.get('date'),
            'text': full_text,
            'file_name': self.get_file_name(primary_msg),
            'hash_tags': all_tags,
            'geo': primary_msg.get('location_information'),
            'author': primary_msg.get('author'),
            'forwarded_from': primary_msg.get('forwarded_from')
        }

    # Один или несколько '#тег' подряд (с пробелами/переносами между ними) в самом конце текста
    _TRAILING_HASHTAGS_RE = re.compile(r'(?:\s*#[^\s#]+)+\s*$', re.UNICODE)

    def strip_trailing_hashtags(self, text):
        """Убирает хэштеги, если они стоят блоком в самом конце текста (они уже попали в frontmatter tags)"""
        if not text:
            return text

        match = self._TRAILING_HASHTAGS_RE.search(text)
        if not match:
            return text

        return text[:match.start()].rstrip()

    def _has_text(self, message):
        """Проверяет, содержит ли сообщение какой-либо текст (не только медиа)"""
        if message.get('rich_message'):
            return bool(message['rich_message'].get('blocks'))

        text_field = message.get('text')
        if text_field is None:
            return False
        if isinstance(text_field, str):
            return bool(text_field.strip())
        if isinstance(text_field, list):
            # Список может содержать строки и словари, но если есть хотя бы один непустой элемент - считаем текстом
            for item in text_field:
                if isinstance(item, str) and item.strip():
                    return True
                if isinstance(item, dict) and item.get('text', '').strip():
                    return True
        return False

    def create_text(self, message):
        """Создаёт текстовое представление одного сообщения (текст + его медиа)"""
        if message.get('rich_message'):
            return self.render_blocks(message['rich_message'].get('blocks', [])).strip()

        entities = self.filter_text_entities(message.get('text_entities', []))
        text_part = self.create_text_from_entities(entities)
        media_part = self.create_media_markdown(message)

        if text_part and media_part:
            return text_part + "\n" + media_part
        elif media_part:
            return media_part
        else:
            return text_part

    def filter_text_entities(self, entities):
        """Убирает ненужные сущности в конце списка (пустые plain и hashtag)"""
        if not entities:
            return []

        list_entities = entities[:]  # копия

        # Удаляем последний элемент, если это пустая plain-сущность
        if list_entities and list_entities[-1].get('type') == "plain" and not list_entities[-1].get('text'):
            list_entities.pop()

        end = len(list_entities) - 1
        # Удаляем все hashtag и пустые plain с конца
        while end >= 0:
            item = list_entities[end]
            is_exclude = item.get('type') == "hashtag" or (item.get('type') == "plain" and not item.get('text').strip())
            if not is_exclude:
                break
            end -= 1

        return list_entities[:end + 1]

    def create_text_from_entities(self, entities):
        """Собирает текст из списка сущностей, преобразуя каждую в markdown"""
        result = []
        for entity in entities:
            text = self.create_text_entity(entity)
            if text:
                result.append(text)
        return ''.join(result).strip()

    def create_text_entity(self, entity):
        entity_type = entity['type']
        text = entity['text']
        if entity_type == "hashtag":
            return text.replace('#', '')
        elif entity_type == "plain":
            return text
        elif entity_type == "blockquote":
            return "\n> " + text.replace('\n', '\n> ') + "\n"
        elif entity_type in ["pre", "code", "spoiler"]:
            return f"\n```\n{text}\n```\n"
        elif entity_type == "text_link":
            return f"[{text}]({entity.get('href')})"
        elif entity_type == "italic":
            return f"*{text}*"
        elif entity_type == "link":
            return f"[{text}]({text})"
        elif entity_type == "bold":
            return f"**{text}**"
        elif entity_type == "strikethrough":
            return f"~~{text}~~"
        elif entity_type == "underline":
            return f"<u>{text}</u>"
        elif entity_type == "custom_emoji":
            # Кастомные эмодзи — выводим их текстовый символ
            return text
        else:
            # Неизвестный тип игнорируем
            return None

    def create_media_markdown(self, message):
        """
        Ищет в сообщении все возможные медиа-поля (photo, file, sticker, video, voice, audio, animation)
        и генерирует для них markdown-ссылки.
        """
        media_lines = []

        # Проверяем наличие разных типов медиа
        if message.get('photo'):
            media_lines.append(self.format_media(message['photo'], 'photo'))
        if message.get('file'):
            media_lines.append(self.format_media(message['file'], 'file'))
        if message.get('sticker'):
            media_lines.append(self.format_media(message['sticker'], 'sticker'))
        if message.get('video'):
            media_lines.append(self.format_media(message['video'], 'video'))
        if message.get('voice'):
            media_lines.append(self.format_media(message['voice'], 'voice'))
        if message.get('audio'):
            media_lines.append(self.format_media(message['audio'], 'audio'))
        if message.get('animation'):
            media_lines.append(self.format_media(message['animation'], 'animation'))

        return '\n'.join(media_lines)

    def format_media(self, media_field, media_type):
        """
        Принимает поле медиа (может быть строкой с путём или объектом с путём).
        Возвращает строку markdown для вставки.
        """
        # Если поле — объект, пытаемся извлечь путь из поля 'file'
        if isinstance(media_field, dict):
            file_path = media_field.get('file', '')
        else:
            file_path = str(media_field)

        # Извлекаем только имя файла из полного пути
        if '/' in file_path:
            file_name = file_path[file_path.rfind('/') + 1:]
        else:
            file_name = file_path

        if not file_name:
            return ""

        # Определяем формат в зависимости от типа и расширения
        ext = file_name.split('.')[-1].lower() if '.' in file_name else ''
        if media_type in ('photo', 'sticker', 'animation') or ext in ('jpg', 'jpeg', 'png', 'gif', 'webp'):
            # Изображения и стикеры
            return f"![]({file_name})"
        elif media_type in ('video', 'animation') or ext in ('mp4', 'mov', 'm4v', 'ogg'):
            # Видео
            return f"![[{file_name}]]"
        elif media_type == 'audio' or ext in ('mp3', 'ogg', 'm4a'):
            # Аудио
            return f"![[{file_name}]]"
        elif ext == 'pdf':
            # PDF как ссылка
            return f"[[{file_name}]]"
        else:
            # Остальные файлы
            return f"[[{file_name}]]"

    # ------------------------------------------------------------------
    # Поддержка нового формата rich_message (структурированные блоки)
    # ------------------------------------------------------------------

    def render_blocks(self, blocks):
        """Рендерит список блоков rich_message в markdown, разделяя их пустой строкой"""
        parts = []
        for block in blocks:
            rendered = self.render_block(block)
            if rendered:
                parts.append(rendered)
        return "\n\n".join(parts)

    def render_block(self, block):
        """Рендерит один блок rich_message в markdown-строку (или None, если блок пуст)"""
        block_type = block.get('type')

        if block_type == 'heading':
            level = max(1, min(int(block.get('level', 1)), 6))
            text = self.render_text_node(block.get('text'))
            return f"{'#' * level} {text}" if text else None

        elif block_type == 'paragraph':
            text = self.render_text_node(block.get('text'))
            return text if text else None

        elif block_type == 'footer':
            text = self.render_text_node(block.get('text'))
            return f"*{text}*" if text else None

        elif block_type == 'divider':
            return "---"

        elif block_type == 'quote':
            return self.render_quote_block(block)

        elif block_type == 'list':
            return self.render_list_block(block)

        elif block_type == 'table':
            return self.render_table_block(block)

        elif block_type == 'details':
            return self.render_details_block(block)

        elif block_type == 'map':
            return self.render_map_block(block)

        elif block_type in ('photo', 'video', 'file', 'voice', 'audio', 'animation', 'sticker'):
            return self.render_media_block(block, block_type)

        else:
            # Неизвестный тип блока — пробуем достать хоть какой-то текст, чтобы не терять контент
            text = self.render_text_node(block.get('text'))
            return text if text else None

    def render_text_node(self, node):
        """Рекурсивно превращает узел форматированного текста rich_message в markdown-строку"""
        if not isinstance(node, dict):
            return ""

        node_type = node.get('type')

        if node_type in (None, 'empty'):
            return ""
        elif node_type == 'plain':
            return node.get('text', '') or ''
        elif node_type == 'concat':
            return ''.join(self.render_text_node(child) for child in node.get('text', []))
        elif node_type == 'bold':
            inner = self.render_text_node(node.get('text'))
            return f"**{inner}**" if inner else ""
        elif node_type == 'italic':
            inner = self.render_text_node(node.get('text'))
            return f"*{inner}*" if inner else ""
        elif node_type == 'underline':
            # У markdown нет нативного подчёркивания — Obsidian рендерит обычный HTML в режиме чтения
            inner = self.render_text_node(node.get('text'))
            return f"<u>{inner}</u>" if inner else ""
        elif node_type == 'strikethrough':
            inner = self.render_text_node(node.get('text'))
            return f"~~{inner}~~" if inner else ""
        elif node_type == 'marked':
            # Obsidian нативно поддерживает выделение через ==текст==
            inner = self.render_text_node(node.get('text'))
            return f"=={inner}==" if inner else ""
        elif node_type == 'spoiler':
            # Спойлер просто показываем как обычный текст
            return self.render_text_node(node.get('text'))
        elif node_type == 'subscript':
            # Markdown не поддерживает под-/надстрочный текст — используем HTML, как и для <u>
            inner = self.render_text_node(node.get('text'))
            return f"<sub>{inner}</sub>" if inner else ""
        elif node_type == 'superscript':
            inner = self.render_text_node(node.get('text'))
            return f"<sup>{inner}</sup>" if inner else ""
        elif node_type in ('code', 'pre'):
            inner = self.render_text_node(node.get('text'))
            return f"`{inner}`" if inner else ""
        elif node_type == 'text_link':
            inner = self.render_text_node(node.get('text'))
            href = node.get('href', '')
            return f"[{inner}]({href})" if inner else ""
        elif node_type == 'link':
            # Автоматически распознанная ссылка — сам текст и есть URL
            inner = self.render_text_node(node.get('text'))
            return f"[{inner}]({inner})" if inner else ""
        elif node_type == 'hashtag':
            # Текст хэштега уже содержит символ '#'
            return self.render_text_node(node.get('text'))
        else:
            # Неизвестный тип — пытаемся достать вложенный текст, чтобы не терять контент
            inner = node.get('text')
            if isinstance(inner, dict):
                return self.render_text_node(inner)
            if isinstance(inner, str):
                return inner
            return ""

    def render_quote_block(self, block):
        """Цитата -> callout Obsidian: > [!quote]"""
        text = self.render_content_node(block)
        if not text:
            return None

        lines = ["> [!quote]"]
        lines.extend(f"> {line}" if line else ">" for line in text.split("\n"))

        caption_text = self.render_text_node(block.get('caption'))
        if caption_text:
            lines.append(">")
            lines.append(f"> — {caption_text}")

        return "\n".join(lines)

    def render_list_block(self, block):
        kind = block.get('kind', 'bullet')
        items = block.get('items', [])
        lines = []

        for index, item in enumerate(items):
            content_text = self.render_content_node(item)
            task_state = item.get('task_state', 'none')

            if task_state == 'checked':
                prefix = "- [x] "
            elif task_state == 'unchecked':
                prefix = "- [ ] "
            elif kind == 'ordered':
                prefix = f"{item.get('num', index + 1)}. "
            else:
                prefix = "- "

            content_lines = content_text.split("\n") if content_text else [""]
            indent = " " * len(prefix)

            lines.append(f"{prefix}{content_lines[0]}")
            for cont_line in content_lines[1:]:
                # Продолжение того же пункта списка — отступ, чтобы markdown не разорвал список.
                # Пустая строка-разделитель между блоками внутри пункта остаётся без отступа.
                lines.append(f"{indent}{cont_line}" if cont_line else "")

        return "\n".join(lines) if lines else None

    def render_content_node(self, container):
        """Универсальный рендер содержимого с полем content: 'text'|'blocks'
        (встречается и в пунктах списков, и в цитатах): либо плоский текстовый
        узел ('text'), либо вложенные блоки ('blocks' — параграфы, списки и т.д.)"""
        if container.get('blocks'):
            return self.render_blocks(container['blocks'])
        return self.render_text_node(container.get('text'))

    def render_table_block(self, block):
        rows = block.get('rows', [])
        if not rows:
            return None

        lines = []
        title_text = self.render_text_node(block.get('title'))
        if title_text:
            lines.append(title_text)
            lines.append("")

        for row_index, row in enumerate(rows):
            cells = row.get('cells', [])
            cell_texts = [self.render_text_node(cell.get('text')).replace('\n', '<br>') for cell in cells]
            lines.append("| " + " | ".join(cell_texts) + " |")
            if row_index == 0:
                lines.append("| " + " | ".join(["---"] * len(cells)) + " |")

        return "\n".join(lines)

    def render_details_block(self, block):
        """Сворачиваемый блок -> callout Obsidian (> [!note]- Заголовок)"""
        title_text = self.render_text_node(block.get('title'))
        inner = self.render_blocks(block.get('blocks', []))
        fold_marker = "+" if block.get('open') else "-"

        header = f"> [!note]{fold_marker} {title_text}".rstrip()
        lines = [header]
        for line in inner.split("\n"):
            lines.append(f"> {line}".rstrip())

        return "\n".join(lines)

    def render_media_block(self, block, media_type):
        media_md = self.format_media(block.get(media_type), media_type)
        if not media_md:
            return None

        caption = block.get('caption')
        caption_text = self.render_text_node(caption.get('text')) if isinstance(caption, dict) else ""
        caption_text = caption_text.strip()

        if caption_text:
            return f"{media_md}\n*{caption_text}*"
        return media_md

    def render_map_block(self, block):
        geo = block.get('geo', {})
        lat = geo.get('latitude')
        lon = geo.get('longitude')
        if lat is None or lon is None:
            return None

        zoom = block.get('zoom', 14)
        # У бесплатного тарифа Яндекс Static API максимум 650x450
        width = min(block.get('width', 600), 650)
        height = min(block.get('height', 450), 450)

        caption = block.get('caption')
        caption_text = self.render_text_node(caption.get('text')) if isinstance(caption, dict) else ""
        label = caption_text if caption_text else f"{lat}, {lon}"

        maps_link = f"https://yandex.ru/maps/?pt={lon},{lat}&z={zoom}&l=map"

        if self.yandex_maps_api_key:
            # Яндекс Static API: координаты в формате "долгота,широта"
            preview_url = (
                f"https://static-maps.yandex.ru/v1?apikey={self.yandex_maps_api_key}"
                f"&ll={lon},{lat}&z={zoom}&size={width},{height}&l=map&pt={lon},{lat},pm2rdm"
            )
            return f"![{label}]({preview_url})\n📍 [{label}]({maps_link})"

        # Без API-ключа превью-картинку не сделать — оставляем просто ссылку
        return f"📍 [{label}]({maps_link})"

    def _collect_hashtags_from_block(self, block, tags):
        """Рекурсивно собирает хэштеги из блока rich_message (текст, заголовок, подпись, вложенные блоки)"""
        for key in ('text', 'title', 'caption'):
            value = block.get(key)
            if isinstance(value, dict):
                self._collect_hashtags_from_node(value, tags)

        if block.get('type') == 'list':
            for item in block.get('items', []):
                if isinstance(item.get('text'), dict):
                    self._collect_hashtags_from_node(item['text'], tags)

        if block.get('type') == 'table':
            for row in block.get('rows', []):
                for cell in row.get('cells', []):
                    if isinstance(cell.get('text'), dict):
                        self._collect_hashtags_from_node(cell['text'], tags)

        if block.get('type') == 'details':
            for inner_block in block.get('blocks', []):
                self._collect_hashtags_from_block(inner_block, tags)

    def _collect_hashtags_from_node(self, node, tags):
        if not isinstance(node, dict):
            return

        node_type = node.get('type')
        if node_type == 'hashtag':
            tag = self.render_text_node(node).replace('#', '').strip()
            if tag and tag not in tags:
                tags.append(tag)
        elif node_type == 'concat':
            for child in node.get('text', []):
                self._collect_hashtags_from_node(child, tags)
        elif isinstance(node.get('text'), dict):
            self._collect_hashtags_from_node(node['text'], tags)

    def create_header(self, post, next_file, prev_file):
        date_obj = datetime.strptime(post['date'], self.date_format)
        date_str = self.format_header_date(date_obj)
        header = f"---\nDate: {date_str}"

        if post.get('forwarded_from'):
            header += f"\nИсточник: {post['forwarded_from']}"

        if post.get('hash_tags'):
            header += "\ntags:\n" + "\n".join(f"  - {tag}" for tag in post['hash_tags'])

        if prev_file:
            header += f'\nBack: "[[{prev_file}]]"'
        if next_file:
            header += f'\nNext: "[[{next_file}]]"'

        return header + "\n---"

    def get_file_name(self, message):
        date_obj = parser.parse(message['date'])
        return date_obj.strftime(self.file_date_format) + ".md"


def main():
    parser = argparse.ArgumentParser(description="Обработка экспорта Telegram в заметки Obsidian")
    parser.add_argument('--input', '--i', type=str, default=os.path.expanduser('~/Downloads/input'),
                        help='Папка с полным экспортом Telegram')
    parser.add_argument('--output', '--o', type=str, default=os.path.expanduser('~/Downloads/output'),
                        help='Папка для сохранения постов в формате *.md')
    parser.add_argument('--yandex-api-key', type=str,
                        default=os.environ.get('YANDEX_MAPS_API_KEY', YANDEX_MAPS_API_KEY),
                        help='API-ключ Яндекс Static Maps для превью локаций (по умолчанию берётся из '
                             'константы YANDEX_MAPS_API_KEY в начале файла, либо из переменной окружения '
                             'YANDEX_MAPS_API_KEY). Без ключа вместо картинки будет просто ссылка.')
    parser.add_argument('-t', '--time', type=int, default=120,
                        help='Порог склейки сообщений в один пост, в секундах (по умолчанию 120, т.е. 2 минуты). '
                             'Сообщения, идущие подряд с разницей меньше указанного значения, объединяются в один пост. '
                             'Если указать 0 — склейка отключается, и каждое сообщение сохраняется как отдельный пост.')
    parser.add_argument('--date-format', type=str, default=None,
                        help='Формат даты в шапке заметки, в виде strftime-строки (например, "%%d.%%m.%%Y %%H:%%M"). '
                             'По умолчанию используется полная дата на русском: "7 сентября 2026, 09:41".')

    args = parser.parse_args()

    input_folder = args.input
    output_folder = args.output

    export = TelegramExport(yandex_maps_api_key=args.yandex_api_key, header_date_format=args.date_format)
    export.copy_folders(input_folder, output_folder)

    json_path = os.path.join(input_folder, "result.json")
    if not os.path.exists(json_path):
        print(f"Ошибка: файл {json_path} не найден.")
        return

    with open(json_path, "r", encoding='utf-8') as f:
        json_data = json.load(f)

    posts = export.get_posts(json_data, threshold=args.time)
    export.save_posts(posts, output_folder)
    print("Готово!")


if __name__ == "__main__":
    main()
