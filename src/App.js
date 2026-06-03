import PdfViewerComponent from "./components/PdfViewerComponent";
import "./App.css";

function App() {
  return (
    <div className="App">
      <PdfViewerComponent document="document.pdf" />
    </div>
  );
}

export default App;
