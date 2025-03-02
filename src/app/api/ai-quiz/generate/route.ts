import { NextRequest, NextResponse } from "next/server";
import Quiz from "@/models/quizModel";
import Question from "@/models/questionModel";
import Session from "@/models/sessionModel";
import { connect } from "@/dbConfig/dbConfig";
import mongoose from "mongoose";
import jwt, { JwtPayload } from "jsonwebtoken";
import OpenAI from "openai";

connect();

interface DecodedToken extends JwtPayload {
  id?: string;
}

export async function POST(request: NextRequest) {
  try {
    const { topic, numQuestions, duration, questionConfigs } = await request.json();
    if (!topic || !numQuestions) {
      return NextResponse.json({ error: "missing required fields" }, { status: 400 });
    }

    // Strong prompt: tell the AI to generate only multiple choice questions.
    const prompt = `Generate ${numQuestions} quiz questions on the topic "${topic}".
IMPORTANT: All questions must be strictly multiple choice only. Do not generate any short answer questions.
Each question must include:
- "question_text"
- "options" (an array of at least 4 choices)
- "correct_answer" (one of the options)
- "points" (this will be overridden by the provided configuration)
Do not include any "question_type" field or markdown formatting.`;

    const tokenCookie = request.cookies.get("authToken");
    if (!tokenCookie || !tokenCookie.value) {
      return NextResponse.json({ error: "user is not authenticated" }, { status: 401 });
    }
    const token = tokenCookie.value;
    let decoded: DecodedToken;
    try {
      if (!process.env.JWT_SECRET) {
        throw new Error("jwt_secret not set in environment");
      }
      decoded = jwt.verify(token, process.env.JWT_SECRET) as DecodedToken;
    } catch (err) {
      return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
    }
    const userId = decoded.id;
    if (!userId) {
      return NextResponse.json({ error: "could not determine user from token" }, { status: 401 });
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      return NextResponse.json({ error: "github token not configured" }, { status: 500 });
    }

    const client = new OpenAI({
      baseURL: "https://models.inference.ai.azure.com",
      apiKey: githubToken,
    });

    const aiResponse = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an assistant that creates quiz questions." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
      top_p: 1,
    });

    let generatedOutput = aiResponse.choices[0]?.message?.content;
    if (!generatedOutput) {
      console.error("No content returned by the AI model");
      return NextResponse.json({ error: "no ai output returned" }, { status: 500 });
    }
    generatedOutput = generatedOutput
      .replace(/```json\s*([\s\S]*?)```/, "$1")
      .replace(/```([\s\S]*?)```/, "$1")
      .trim();

    let generatedQuestions;
    try {
      generatedQuestions = JSON.parse(generatedOutput);
    } catch (err) {
      try {
        const fixedOutput = `[${generatedOutput.replace(/}\s*{/g, "},{")}]`;
        generatedQuestions = JSON.parse(fixedOutput);
      } catch (err2) {
        const regex = /{[^}]+}/g;
        const matches = generatedOutput.match(regex);
        if (matches && matches.length > 0) {
          const joined = `[${matches.join(",")}]`;
          try {
            generatedQuestions = JSON.parse(joined);
          } catch (err3) {
            console.error("Error parsing extracted JSON objects:", err3, joined);
            return NextResponse.json({ error: "failed to parse generated questions" }, { status: 500 });
          }
        } else {
          console.error("Error parsing model output:", err2, generatedOutput);
          return NextResponse.json({ error: "failed to parse generated questions" }, { status: 500 });
        }
      }
    }

    // Ensure generatedQuestions is an array.
    if (!Array.isArray(generatedQuestions)) {
      generatedQuestions = [generatedQuestions];
    }

    console.log("AI generated questions (before filtering):", generatedQuestions);

    // Filter out any questions that don't have at least 4 options.
    const filteredQuestions = generatedQuestions.filter((q: any) =>
      Array.isArray(q.options) && q.options.length >= 4
    );

    // If filtering removes all questions, use an empty array.
    if (filteredQuestions.length === 0) {
      console.error("No valid multiple choice questions found in AI output:", generatedQuestions);
      return NextResponse.json({ error: "failed to generate valid multiple choice questions" }, { status: 500 });
    }

    console.log("Filtered questions (MCQs only):", filteredQuestions);

    const newQuiz = new Quiz({
      title: `ai quiz on ${topic}`,
      description: `automatically generated quiz about ${topic}`,
      created_by: new mongoose.Types.ObjectId(userId),
      duration: duration || 10,
      total_points: 0,
    });
    await newQuiz.save();

    // Build questionDocs while ignoring any question_type from the AI.
    const questionDocs = filteredQuestions.map((q: any, index: number) => {
      // If options are missing or not enough, force default options.
      let options = Array.isArray(q.options) && q.options.length >= 4 ? q.options : ["Option A", "Option B", "Option C", "Option D"];
      // Ensure the correct_answer is one of the options.
      let correct_answer = (q.correct_answer && options.includes(q.correct_answer)) ? q.correct_answer : options[0];

      return {
        quiz_id: newQuiz._id,
        question_text: q.question_text,
        question_type: "MCQ", 
        options: options,
        correct_answer: correct_answer,
        points: questionConfigs[index]?.points || 10,
      };
    });

    console.log("Final questionDocs:", questionDocs);

    await Question.insertMany(questionDocs);

    const totalQuizPoints = questionDocs.reduce((sum: number, q: any) => sum + q.points, 0);
    newQuiz.total_points = totalQuizPoints;
    await newQuiz.save();

    const sessionStartTime = new Date();
    const sessionEndTime = new Date(sessionStartTime.getTime() + newQuiz.duration * 60000);
    const newSession = new Session({
      quiz_id: newQuiz._id,
      start_time: sessionStartTime,
      end_time: sessionEndTime,
      is_active: true,
    });
    await newSession.save();

    return NextResponse.json(
      {
        success: true,
        quizId: newQuiz._id,
        sessionId: newSession._id,
        join_code: newSession.join_code,
        message: "ai quiz generated successfully",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error generating AI quiz:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
