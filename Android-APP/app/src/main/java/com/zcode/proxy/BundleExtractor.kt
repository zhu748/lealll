package com.zcode.proxy

import java.io.File
import java.io.InputStream

/** Commit the version marker last so an interrupted upgrade is retried. */
internal class BundleExtractor(private val directory: File) {
    fun extract(version: String, names: List<String>, open: (String) -> InputStream): Boolean {
        directory.mkdirs()
        val marker = File(directory, ".extracted-version")
        if (marker.isFile && marker.readText() == version && names.all { File(directory, it).length() > 0 }) {
            return false
        }
        names.forEach { name ->
            writeAtomically(File(directory, name)) { output -> open(name).use { it.copyTo(output) } }
        }
        writeAtomically(marker) { it.write(version.toByteArray(Charsets.UTF_8)) }
        return true
    }

    private fun writeAtomically(target: File, write: (java.io.OutputStream) -> Unit) {
        val temporary = File.createTempFile("bundle-", ".tmp", directory)
        try {
            temporary.outputStream().use(write)
            check(temporary.renameTo(target)) { "无法写入运行文件 ${target.name}" }
        } finally {
            temporary.delete()
        }
    }
}
