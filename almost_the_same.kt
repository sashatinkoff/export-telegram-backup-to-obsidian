package com.isidroid.c23

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.annotations.SerializedName
import com.isidroid.utils.fileNameExtension
import com.isidroid.utils.fromJson
import com.isidroid.utils.saveString
import org.junit.Test
import java.io.File
import java.text.DateFormat
import java.time.Month
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Calendar
import java.util.Date
import java.util.concurrent.TimeUnit

class TelegramExport2ObsidianTest {
    @Test
    fun makeTest() {
        val directoryPath = "src/test/resources/"
        val folder = File(directoryPath)
        val json = folder.listFiles().orEmpty().first { it.name == "tg_export_2409.json" }.readText()

        val inputFolder = "input"
        val outputFolder = "output"

        val export = TelegramExport()
        export.copyFolders(inputFolder, outputFolder)

        val posts = export.getPosts(json)
        export.savePosts(posts, outputFolder)
    }
}

fun main() {
    val inputFolder = "input"
    val outputFolder = "output"

    val export = TelegramExport()
    export.copyFolders(inputFolder, outputFolder)

    val json = File(inputFolder, "result.json").readText()
    val posts = export.getPosts(json)
    export.savePosts(posts, outputFolder)
}

class TelegramExport {
    private val gson: Gson = GsonBuilder()
        .setDateFormat("yyyy-MM-dd'T'HH:mm:ss")
        .create()

    private val dateFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH-mm-ss")


    fun savePosts(posts: List<TgPost>, outputFolder: String) {
        var index = 0
        while (index < posts.size) {
            val prevFile = posts.getOrNull(index - 1)?.fileName
            val nextFile = posts.getOrNull(index + 1)?.fileName
            val post = posts[index]
            val header = createHeader(post, nextFile, prevFile)

            val text = buildString {
                append(header)
                appendLine()
                append(post.text)
            }
            println(text)

            val file = saveToFile(text, post.date, post.fileName, outputFolder)
            println("saved $index/${posts.size}, file=$file")

            index++
        }
    }

    fun copyFolders(inputFolder: String, outputFolder: String) {
        // copy each folder from input to output
        val input = File(inputFolder)
        val output = File(outputFolder)

        val files = output.listFiles()?.filter { it.isDirectory } ?: return
        for (folder in files) {
            val target = File(input, folder.name)
            println("copy ${folder.name}")
            try {

            } catch (_: Throwable) {
                folder.copyRecursively(target, false)
            }
        }
    }

    private fun saveToFile(text: String, date: Date, fileName: String, outputFolder: String): String {
        val calendar = Calendar.getInstance()
        calendar.time = date
        val folderName = getFolderName(calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH) + 1)
        val folder = File(outputFolder, folderName)

        val file = File(folder, fileName)
        try {
            file.saveString(text)
        } catch (_: Throwable) {
        }

        return file.absolutePath
    }

    private fun getFolderName(year: Int, month: Int): String {
        val monthName = Month.of(month).name.lowercase().replaceFirstChar { it.uppercase() }
        val formattedMonth = String.format("%02d", month)
        return "notes/$year/$year-$formattedMonth-$monthName"
    }

    fun getPosts(json: String): List<TgPost> {
        val result = mutableListOf<TgPost>()
        val list = gson.fromJson<Response>(json).messages

        var start = 0

        while (start < list.size) {
            val message = list[start]
            var date = message.date
            val text = StringBuilder()
            text.appendLine()
            text.append(createText(message))

            var nextStart = start + 1
            val tresHold = TimeUnit.MINUTES.toMillis(2)
            while (nextStart < list.size) {
                val nextMessage = list[nextStart]
                val isSameDate = (nextMessage.date.time - date.time) < tresHold

                if (!isSameDate)
                    break

                date = nextMessage.date

                text.appendLine()
                text.append(createText(nextMessage))

                nextStart++
            }

            start = nextStart

            val hashTags = message.entities?.filter { it.type == "hashtag" }?.map { it.text.replace("#", "") }
            val post = TgPost(message.id, message.date, text.toString(), getFileName(message), hashTags, message.geo)

            result.add(post)
        }

        return result
    }

    private fun createText(message: MessageResponse): String? {
        val entities = filterTextEntities(message.entities)
        return createText2(entities, message.photo, message.file)
    }

    private fun filterTextEntities(entities: List<TextEntityResponse>?): List<TextEntityResponse> {
        val list = entities.orEmpty().toMutableList()
        if (list.lastOrNull()?.type == "plain" && list.lastOrNull()?.text.isNullOrBlank())
            list.removeLast()

        var end = list.size - 1
        while (end >= 0) {
            val item = list[end]
            val isExclude = item.type == "hashtag" || (item.type == "plain" && item.text.isBlank())
            if (!isExclude)
                break

            end--
        }


        return list.take(end + 1)
    }

    private fun createText2(entities: List<TextEntityResponse>, photo: String?, file: String?): String? {
        val result = StringBuilder()
        val text = entities
            .joinToString("") {
                createText(it).orEmpty()
            }.takeIf { it.isNotBlank() }

        if (!text.isNullOrBlank())
            result.appendLine(text)

        val attach = (photo ?: file)?.let {
            if (!it.contains("/")) return@let it
            it.substring(it.lastIndexOf("/") + 1, it.length)
        }

        if (attach != null) {
            val fileExtension = attach.fileNameExtension.lowercase()
            val code = when (fileExtension) {
                "m4v", "mp4", "mov", "ogg" -> "![[$attach]]"
                "pdf" -> "[[$attach]]"
                else -> "![]($attach)"
            }
            result.append(code).appendLine()
        }

        return result.toString()
    }


    private fun createText(entity: TextEntityResponse): String? {
        return when (entity.type) {
            "hashtag" -> entity.text.replace("#", "")
            "plain" -> entity.text
            "blockquote" -> "\n> ${entity.text}".replace("\n", "\n> ")
            "pre", "code", "spoiler" -> "\n```\n${entity.text}\n```\n"
            "text_link" -> "[${entity.text}](${entity.href})"
            "italic" -> "*${entity.text}*"
            "link" -> "[${entity.text}](${entity.text})"
            "bold" -> "**${entity.text}**"
            "strikethrough" -> "~~${entity.text}~~"
            "underline" -> "++${entity.text}++"
            else -> null
        }
    }

    private fun createHeader(post: TgPost, prevFile: String?, nextFile: String?) = buildString {
        val timeFormat = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM)
        val hashTags = post.hashTags.orEmpty()

        append("---\n")
        append("Date: ", timeFormat.format(post.date))

        if (hashTags.isNotEmpty()) {
            append("\n", "tags:")
            for (tag in hashTags) {
                append("\n", "  - ${tag}")
            }
        }

        post.geo?.let {
            append("\n", "Location: ", "[Open map](https://maps.google.com/?q=${it.lat},${it.lng})")
        }

        prevFile?.let { append("\n", "Back: \"[[$it]]\"") }
        nextFile?.let { append("\n", "Next: \"[[$it]]\"") }

        append("\n---")
    }


    private fun getFileName(message: MessageResponse): String {
        val time = dateFormatter.format(message.date.toInstant().atZone(ZoneId.systemDefault()).toLocalDateTime())
        return "$time.md"
    }
}


data class Response(@SerializedName("messages") val messages: List<MessageResponse>)
data class MessageResponse(
    @SerializedName("id") val id: Int,
    @SerializedName("date") val date: Date,
    @SerializedName("file") val file: String?,
    @SerializedName("photo") val photo: String?,
    @SerializedName("location_information") val geo: GeoResponse?,
    @SerializedName("text_entities") val entities: List<TextEntityResponse>?
)

data class TextEntityResponse(
    @SerializedName("type") val type: String,
    @SerializedName("text") val text: String,
    @SerializedName("href") val href: String?,
)

data class GeoResponse(@SerializedName("latitude") val lat: Double, @SerializedName("longitude") val lng: Double)
data class TgPost(val id: Int, val date: Date, val text: String, val fileName: String, val hashTags: List<String>?, val geo: GeoResponse?)
