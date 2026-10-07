package com.zcode.proxy

import java.net.InetAddress
import java.net.ServerSocket

/** Separate JVM with a real port and an optional slow shutdown hook. */
internal object ProcessFixture {
    @JvmStatic fun main(args: Array<String>) {
        val shutdownDelay = args[0].toLong()
        Runtime.getRuntime().addShutdownHook(Thread {
            try { Thread.sleep(shutdownDelay) }
            catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        })
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { socket ->
            println(socket.localPort)
            System.out.flush()
            Thread.sleep(60_000)
        }
    }
}
