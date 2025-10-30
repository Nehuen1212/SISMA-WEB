document.addEventListener('DOMContentLoaded', function() {
    const contactForm = document.getElementById('contact-form');
    const mensajeEnviado = document.getElementById('mensaje-enviado');

    // Protegemos el código por si el formulario no está en la página.
    if (!contactForm) {
        // No hay formulario, nada que hacer.
        return;
    }

    contactForm.addEventListener('submit', function(event) {
        event.preventDefault();

        // Aquí podrías agregar la lógica para enviar el formulario a un servidor
        // o para procesar los datos localmente.
        // Para este ejemplo, simplemente mostraremos un mensaje de éxito.

        if (mensajeEnviado) {
            contactForm.style.display = 'none';
            mensajeEnviado.style.display = 'block';

            // Resetear el formulario después de un tiempo
            setTimeout(() => {
                contactForm.reset();
                contactForm.style.display = 'block';
                mensajeEnviado.style.display = 'none';
            }, 3000); // Mostrar el mensaje por 3 segundos
        } else {
            // Si no existe el contenedor de mensaje, solo resetear.
            contactForm.reset();
        }
    });
});