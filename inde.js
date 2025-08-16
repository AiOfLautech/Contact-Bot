      const formattedCode = data.code.replace(/(\d{4})(\d{4})/, '$1-$2');
      codeEl.textContent = formattedCode;
      codeDisplay.classList.remove('hidden');
    });
    
    // Handle connection error
    socket.on('connect_error', () => {
      document.getElementById('status').textContent = 'SERVER CONNECTION ERROR';
    });
  </script>
</body>
</html>
  `);
});

// Start bot
bot.launch().then(() => {
  console.log('🚀 Bot started');
  console.log('🌐 Status page available at:', `${process.env.SERVER_URL}/status.html`);
});

// Handle graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
